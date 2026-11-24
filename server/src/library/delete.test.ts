import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { recapture } from '#capture/records.ts'
import { startUpdate } from '#capture/updates.ts'
import { collections, library, shares } from '#db/schema.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { deleteCollection, deleteCollections } from './delete.ts'
import { createShare } from './shares.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`
const member = (id: string) => ({
  url: post(id),
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '',
  mediaTypes: [] as string[],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
})

/**
 * Accounts and what their timelines list: posts they wrote and posts they
 * reposted. Each post has an author and may quote another post.
 */
interface Account {
  wrote: string[]
  reposted: string[]
}
interface Post {
  author: string
  quotes?: string
  mentions?: string[]
}

function setup(accounts: Record<string, Account>, posts: Record<string, Post>) {
  const made = libraryContext((req): Partial<FetchResponse> => {
    if (req.kind === 'profile') {
      const account = accounts[req.externalId]!
      return {
        text: `profile ${req.externalId}`,
        graph: graph(
          [
            entity('root', 'fake.profile', req.externalId),
            ...account.reposted.map((id) => entity(id, 'fake.post', id)),
          ],
          ...account.reposted.map(
            (id) => ['root', 'reposted', id] as [string, string, string],
          ),
        ),
        relatedTargets: [...account.wrote, ...account.reposted].map(member),
      }
    }
    const { author, quotes, mentions = [] } = posts[req.externalId]!
    return {
      text: `post ${req.externalId}`,
      graph: graph(
        [
          entity('root', 'fake.post', req.externalId),
          entity('author', 'fake.profile', author),
          ...(quotes ? [entity('quote', 'fake.post', quotes)] : []),
          ...mentions.map((id) => entity(`m${id}`, 'fake.profile', id)),
        ],
        ['root', 'authored_by', 'author'],
        ...mentions.map(
          (id) => ['root', 'mentions', `m${id}`] as [string, string, string],
        ),
        ...(quotes
          ? [['root', 'quoted', 'quote'] as [string, string, string]]
          : []),
      ),
      relatedTargets: quotes ? [member(quotes)] : [],
    }
  })
  ctx = made.ctx
  return made.ctx
}

/** Saved collection ids by the platform's id of their root. */
function saved(c: CaptureContext) {
  return Object.fromEntries(
    c.db
      .select({ id: collections.id, external: collections.externalId })
      .from(collections)
      .innerJoin(library, eq(library.collectionId, collections.id))
      .all()
      .map((row) => [row.external, row.id]),
  )
}

describe('deleting collections', () => {
  test('an account takes the posts only it holds', async () => {
    const c = setup(
      {
        // He; a second account deleted with him; one that stays.
        1: {
          wrote: [
            'mine',
            'quoting',
            'quoting2',
            'direct',
            'refreshed',
            'shout',
          ],
          reposted: ['alone', 'both', 'theirs', 'pair', 'tagged', 'noted'],
        },
        2: { wrote: [], reposted: ['pair', 'batched'] },
        3: { wrote: ['theirs', 'otherquote'], reposted: ['both'] },
        // Gone before, leaving a post of his that only mentions 1.
        5: { wrote: ['aside'], reposted: [] },
      },
      {
        // Mentioning others does not hold his own posts back...
        mine: { author: '1', mentions: ['9', '2'] },
        // ...unless a saved account that stays is mentioned.
        shout: { author: '1', mentions: ['3'] },
        // Only mentioning him is no reason to go with him.
        aside: { author: '5', mentions: ['1'] },
        quoting: { author: '1', quotes: 'quoted' },
        quoting2: { author: '1', quotes: 'quoted2' },
        quoted: { author: '9' },
        quoted2: { author: '9' },
        otherquote: { author: '3', quotes: 'quoted2' },
        direct: { author: '1' },
        refreshed: { author: '1' },
        batched: { author: '1' },
        alone: { author: '9' },
        both: { author: '9' },
        theirs: { author: '3' },
        pair: { author: '9' },
        tagged: { author: '9' },
        noted: { author: '9' },
      },
    )
    for (const id of ['1', '2', '3', '5']) await capture(c, profile(id))
    let ids = saved(c)
    deleteCollection(c.db, ids[5]!)
    // Saved on its own, after the timeline brought it in.
    await capture(c, post('direct'))
    // Refreshes are no saves of their own.
    await capture(c, { refreshId: ids.refreshed })
    recapture(c, ids.refreshed!)
    startUpdate(c, { target: 'many', ids: [ids.batched!] })
    await c.queue.drain()
    updateAnnotation(c.db, ids.tagged!, { tagNames: ['keep'] })
    updateAnnotation(c.db, ids.noted!, { note: 'mine' })
    ids = saved(c)
    const profileShare = createShare(c.db, {
      target: 'collection',
      id: ids[1]!,
    })
    const postShare = createShare(c.db, { target: 'collection', id: ids.mine! })
    const keptShare = createShare(c.db, { target: 'collection', id: ids.both! })

    const selection = [ids[1]!, ids[2]!]
    // Without the posts, only the accounts.
    expect(deleteCollections(c.db, selection, { dryRun: true })).toEqual({
      profiles: 2,
      posts: 0,
      related: 0,
      kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
    })
    const dry = deleteCollections(c.db, selection, {
      withPosts: true,
      dryRun: true,
    })
    expect(dry).toEqual({
      profiles: 2,
      posts: 0,
      // mine, quoting, quoting2, quoted, refreshed, batched, alone, pair
      related: 8,
      kept: {
        // both (reposted by 3 too), theirs (3 wrote it), shout (mentions 3)
        listed: 3,
        // direct
        saved: 1,
        annotated: 2,
        // quoted2, which 3's post quotes too
        quoted: 1,
      },
    })
    // A dry run changes nothing.
    expect(Object.keys(saved(c)).toSorted()).toEqual(
      Object.keys(ids).toSorted(),
    )

    expect(deleteCollections(c.db, selection, { withPosts: true })).toEqual(dry)
    expect(Object.keys(saved(c)).toSorted()).toEqual(
      [
        '3',
        'both',
        'theirs',
        'direct',
        'tagged',
        'noted',
        'quoted2',
        'otherquote',
        'shout',
        'aside',
      ].toSorted(),
    )
    const removed = c.db
      .select({ at: collections.unreferencedAt })
      .from(collections)
      .where(eq(collections.id, ids.mine!))
      .get()
    expect(removed?.at).toBeInstanceOf(Date)
    const live = (id: string) =>
      c.db.select().from(shares).where(eq(shares.id, id)).get()?.revokedAt
    expect(live(profileShare.id)).toBeInstanceOf(Date)
    expect(live(postShare.id)).toBeInstanceOf(Date)
    expect(live(keptShare.id)).toBeNull()
  })

  test('selected posts go whatever holds them', async () => {
    const c = setup(
      { 1: { wrote: ['mine'], reposted: [] } },
      { mine: { author: '1' }, other: { author: '9' } },
    )
    await capture(c, profile('1'))
    await capture(c, post('other'))
    const ids = saved(c)
    updateAnnotation(c.db, ids.other!, { note: 'n' })
    expect(
      deleteCollections(c.db, [ids.mine!, ids.other!, 'missing'], {
        withPosts: true,
      }),
    ).toEqual({
      profiles: 0,
      posts: 2,
      related: 0,
      kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
    })
    expect(Object.keys(saved(c))).toEqual(['1'])
    expect(() => deleteCollections(c.db, [ids.mine!])).toThrow(
      '内容不存在或已删除',
    )
    deleteCollection(c.db, ids[1]!)
    expect(saved(c)).toEqual({})
  })
})
