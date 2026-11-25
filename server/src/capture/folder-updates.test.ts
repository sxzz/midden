import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  listTags,
  readAnnotation,
  updateAnnotation,
} from '#library/annotations.ts'
import { createFolder } from '#library/folders.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { captureURL } from './records.ts'
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
    return listTags(c.db).find((t) => t.name === name)!.id
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
