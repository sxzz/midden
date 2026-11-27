import { Buffer } from 'node:buffer'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { library, updates } from '#db/schema.ts'
import {
  listTags,
  readAnnotation,
  updateAnnotation,
} from '#library/annotations.ts'
import { createFolder, deleteFolder, updateFolder } from '#library/folders.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { SYSTEM } from '#users/principal.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { captureURL } from './records.ts'
import { planUpdate, type UpdateTargetInput } from './update-start.ts'
import { previewUpdate, startUpdate, updateRecord } from './updates.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** Each profile's timeline, newest first; every post is by its profile. */
const TIMELINES: Record<string, string[]> = {
  '100': ['1', '2'],
  '200': ['3', '4'],
}
/** Who wrote each post: the profile whose timeline lists it, else 300. */
const authorOf = (post: string) =>
  Object.keys(TIMELINES).find((id) => TIMELINES[id]!.includes(post)) ?? '300'

const target = (id: string) => ({
  url: `https://fake.test/p/${id}`,
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '',
  mediaTypes: [],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
})

/**
 * Profiles 100 (posts 1, 2) and 200 (posts 3, 4) with their timelines, and
 * post 5 by 300, whose profile is not saved.
 */
async function setup() {
  const c = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          if (req.kind === 'post') {
            const graph = postGraph(req.externalId, {})
            graph.entities[1]!.externalId = authorOf(req.externalId)
            return { text: `post ${req.externalId}`, graph }
          }
          return {
            ...fakeProfile(req.externalId),
            providerId: req.providerId,
            relatedTargets: (TIMELINES[req.externalId] ?? []).map(target),
            nextPageCursor: '',
          }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx = c
  c.queue.start()
  const ids: Record<string, string> = {}
  for (const url of [
    'https://fake.test/u/100',
    'https://fake.test/u/200',
    'https://fake.test/p/5',
  ]) {
    const job = captureURL(c, url, undefined, resolveOptions({ count: 3 }))
    await c.queue.drain()
    ids[url.split('/').pop()!] = job.collectionId
  }
  for (const post of ['1', '2', '3', '4'])
    ids[post] = c.db.get<{ id: string }>(
      sql`SELECT id FROM collections WHERE kind = 'post'
        AND external_id = ${post}`,
    )!.id
  /** Add a tag to these items, keeping theirs; its id. */
  const tag = (name: string, ...items: string[]) => {
    for (const item of items) {
      const names = readAnnotation(c.db, ids[item]!).tags.map((t) => t.name)
      updateAnnotation(c.db, ids[item]!, { tagNames: [...names, name] })
    }
    return listTags({ db: c.db, principal: SYSTEM }).find(
      (t) => t.name === name,
    )!.id
  }
  /** What updating a folder with this filter covers. */
  let made = 0
  const covers = (filter: string) => {
    const folder = createFolder(c.db, { name: `f${made++}`, filter })
    const { posts, profiles } = previewUpdate(c, {
      target: 'folder',
      id: folder.id,
    })
    return { posts, profiles, folder: folder.id }
  }
  return { c, ids, tag, covers }
}

const author = (id: string) =>
  `author=${encodeURIComponent(`fake/fake.profile/${id}`)}`

describe('更新收藏夹', () => {
  test('a tag on accounts updates the accounts, which read their posts', async () => {
    const { c, tag, covers } = await setup()
    const id = tag('账号', '100', '200')
    // The folder lists both accounts and, through them, their four posts.
    const { folder, ...counts } = covers(`tag=${id}`)
    expect(counts).toEqual({ posts: 0, profiles: 2 })
    // Without their posts, the posts stay as they are: that is the choice.
    const update = startUpdate(
      c,
      { target: 'folder', id: folder },
      { options: resolveOptions({ posts: 'none' }) },
    )
    await c.queue.drain()
    expect(updateRecord(c.db, update)).toMatchObject({
      state: 'complete',
      update: { posts: 0, profiles: 2 },
      members: { total: 2 },
    })
  })

  test('a tag on posts updates those posts alone', async () => {
    const { tag, covers } = await setup()
    const id = tag('帖子', '1', '5')
    expect(covers(`tag=${id}`)).toMatchObject({ posts: 2, profiles: 0 })
  })

  test('a post tagged itself is updated even when its account is', async () => {
    const { tag, covers } = await setup()
    tag('混合', '100', '2')
    const id = tag('混合', '3')
    // Account 100; post 2 is tagged itself, post 3's account is not in the
    // folder; post 1 is there only through account 100.
    expect(covers(`tag=${id}`)).toMatchObject({ posts: 2, profiles: 1 })
    // Asking for every tag, each must be the post's own: post 1 has both,
    // post 2 has 其他 only through account 100.
    tag('混合', '1')
    const other = tag('其他', '100', '1')
    expect(covers(`tag=${id},${other}&tag_mode=all`)).toMatchObject({
      posts: 1,
      profiles: 1,
    })
  })

  test('posts there through an account outside the folder are updated', async () => {
    const { tag, covers } = await setup()
    const id = tag('账号', '100')
    // The author filter only selects posts, so account 100 is not there.
    expect(covers(`tag=${id}&${author('100')}`)).toMatchObject({
      posts: 2,
      profiles: 0,
    })
  })

  test('the author filter selects posts on their own', async () => {
    const { covers } = await setup()
    expect(covers(author('100'))).toMatchObject({ posts: 2, profiles: 0 })
    expect(covers(`${author('100')}&${author('300')}`)).toMatchObject({
      posts: 3,
      profiles: 0,
    })
  })

  test('the 关系 filter updates the accounts, and posts by the unsaved', async () => {
    const { c, covers } = await setup()
    const entity = (id: string) =>
      c.db.get<{ id: string }>(
        sql`SELECT id FROM entities WHERE kind = 'fake.profile'
          AND external_id = ${id}`,
      )!.id
    for (const followee of ['100', '300'])
      c.db.run(sql`INSERT INTO follow_edges
        (follower_id, followee_id, first_seen_at, last_seen_at)
        VALUES (${entity('200')}, ${entity(followee)}, 1000, 2000)`)
    const filter = `rel=following&rel_of=${encodeURIComponent('fake/fake.profile/200')}`
    // Account 100 with its posts 1 and 2, and post 5: 300 has no profile
    // saved to update it.
    expect(covers(filter)).toMatchObject({ posts: 1, profiles: 1 })
  })

  test('a filter on the items themselves updates every one', async () => {
    const { covers } = await setup()
    // Everything matches on its own merits.
    expect(covers('')).toMatchObject({ posts: 5, profiles: 2 })
    expect(covers('q=post')).toMatchObject({ posts: 5, profiles: 0 })
  })
})

describe('更新收藏夹, planned on a read thread', () => {
  /** The update's row, without what tells two apart. */
  const row = (c: AccountsContext, id: string) => {
    const {
      id: _,
      createdAt: __,
      ...rest
    } = c.db.select().from(updates).where(eq(updates.id, id)).get()!
    return rest
  }

  test('starts the same update as one read where it is written', async () => {
    const { c, tag, ids } = await setup()
    const id = tag('混合', '100', '2', '5')
    const folder = createFolder(c.db, { name: 'mixed', filter: `tag=${id}` })
    const input = { target: 'folder', id: folder.id } as const
    const options = { options: resolveOptions({ posts: 'none' }) }
    const planned = startUpdate(c, input, {
      ...options,
      plan: planUpdate(c.db, input),
    })
    const read = startUpdate(c, input, options)
    expect(row(c, planned)).toEqual(row(c, read))
    expect(row(c, planned).collectionIds.toSorted()).toEqual(
      [ids['100']!, ids['2']!, ids['5']!].toSorted(),
    )
    await c.queue.drain()
    const { id: _, createdAt: __, ...record } = updateRecord(c.db, planned)
    expect(record).toMatchObject({ state: 'complete', members: { total: 3 } })
    const { id: ___, createdAt: ____, ...again } = updateRecord(c.db, read)
    expect(record).toEqual({ ...again, finishedAt: record.finishedAt })
    // A selection and a single collection alike.
    const others: UpdateTargetInput[] = [
      { target: 'many', ids: [ids['1']!, ids['5']!] },
      { target: 'collection', id: ids['200']! },
    ]
    for (const other of others) {
      const first = startUpdate(c, other, { plan: planUpdate(c.db, other) })
      expect(row(c, first)).toEqual(row(c, startUpdate(c, other)))
    }
  })

  test('the plan is written while the folder is as it was', async () => {
    const { c, tag, ids } = await setup()
    const id = tag('帖子', '1', '3')
    const folder = createFolder(c.db, { name: 'posts', filter: `tag=${id}` })
    const input = { target: 'folder', id: folder.id } as const
    const plan = planUpdate(c.db, input)
    // A post tagged meanwhile is left out, as one tagged just after the
    // update started; one taken out of the library meanwhile is skipped
    // at its turn, as one taken out while the update runs.
    tag('帖子', '5')
    c.db.delete(library).where(eq(library.collectionId, ids['3']!)).run()
    const update = startUpdate(c, input, {
      plan,
      options: resolveOptions({ posts: 'none' }),
    })
    expect(row(c, update).collectionIds).toEqual(plan.collectionIds)
    await c.queue.drain()
    expect(updateRecord(c.db, update)).toMatchObject({
      state: 'partial',
      update: { posts: 1, skipped: 1 },
    })
  })

  test('a folder changed or gone since its plan is read again', async () => {
    const { c, tag, ids } = await setup()
    const id = tag('帖子', '1', '3')
    const folder = createFolder(c.db, { name: 'posts', filter: `tag=${id}` })
    const input = { target: 'folder', id: folder.id } as const
    let plan = planUpdate(c.db, input)
    updateFolder(c.db, folder.id, { filter: `tag=${id}&${author('100')}` })
    expect(row(c, startUpdate(c, input, { plan })).collectionIds).toEqual([
      ids['1']!,
    ])
    // Renamed: the record names the folder as it is.
    plan = planUpdate(c.db, input)
    updateFolder(c.db, folder.id, { name: 'renamed' })
    expect(row(c, startUpdate(c, input, { plan })).name).toBe('renamed')
    // Deleted: there is nothing to update.
    plan = planUpdate(c.db, input)
    deleteFolder(c.db, folder.id)
    expect(() => startUpdate(c, input, { plan })).toThrow(
      expect.objectContaining({ kind: 'not_found' }),
    )
    // A selection with an item taken out of the library is not started.
    const many: UpdateTargetInput = {
      target: 'many',
      ids: [ids['1']!, ids['5']!],
    }
    plan = planUpdate(c.db, many)
    c.db.delete(library).where(eq(library.collectionId, ids['5']!)).run()
    expect(() => startUpdate(c, many, { plan })).toThrow(
      expect.objectContaining({ kind: 'not_found' }),
    )
  })
})
