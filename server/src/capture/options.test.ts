import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { collections, relationFetches, submissions } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { DEFAULT_OPTIONS, resolveOptions, type OptionsBody } from './options.ts'
import { captureURL, recordDetail, recordPage } from './records.ts'
import {
  continueTimeline,
  startUpdate,
  updateDetail,
  updateRecord,
} from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const DAY = 86_400_000
const PROFILE = 'https://fake.test/u/100'

interface Post {
  id: number
  type: 'post' | 'quote' | 'repost'
  media: boolean
  /** Days since it was published. */
  age: number
}

/** A timeline, newest first; quotes and reposts refer to post 1000 + id. */
const TIMELINE: Post[] = [
  { id: 1, type: 'post', media: true, age: 1 },
  { id: 2, type: 'quote', media: false, age: 2 },
  { id: 3, type: 'repost', media: true, age: 3 },
  { id: 4, type: 'post', media: false, age: 10 },
  { id: 5, type: 'post', media: true, age: 20 },
  { id: 6, type: 'quote', media: true, age: 40 },
]

function setup(timeline = TIMELINE, timelineCap?: number) {
  const now = Date.now()
  const byId = new Map(timeline.map((p) => [p.id, p]))
  const c = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            if (req.kind === 'post') {
              const post = byId.get(Number(req.externalId))
              return {
                text: 'post',
                graph: postGraph(req.externalId, {}),
                relatedTargets:
                  post && post.type !== 'post'
                    ? [
                        {
                          url: `https://fake.test/p/${1000 + post.id}`,
                          refreshAfterSeconds: 0,
                          updatedAt: '',
                          publishedAt: '',
                          mediaTypes: [],
                          postType: 'post',
                          prefetch: Buffer.alloc(0),
                        },
                      ]
                    : [],
              }
            }
            const start = Number(req.pageCursor || 0)
            const next = start + 3
            return {
              ...fakeProfile(req.externalId),
              relatedTargets: timeline.slice(start, next).map((p) => ({
                url: `https://fake.test/p/${p.id}`,
                refreshAfterSeconds: 0,
                updatedAt: '',
                publishedAt: new Date(now - p.age * DAY).toISOString(),
                mediaTypes: p.media ? ['image'] : [],
                postType: p.type,
                prefetch: Buffer.alloc(0),
              })),
              nextPageCursor: next < timeline.length ? String(next) : '',
              maxBatchSize: 1000,
            }
          },
        },
        { current: () => ({ accounts: [], nextCursor: '' }) },
      ),
    ],
    handlers: captureHandlers,
    timelineCap,
  })
  ctx = c
  c.queue.start()
  return c
}

/** Saved posts: the timeline's, and the ones they refer to. */
function saved(c: CaptureContext) {
  const ids = c.db
    .select({ id: collections.externalId })
    .from(collections)
    .where(eq(collections.kind, 'post'))
    .all()
    .map((row) => Number(row.id))
    .toSorted((a, b) => a - b)
  return {
    posts: ids.filter((id) => id < 1000),
    references: ids.filter((id) => id >= 1000),
  }
}

/** Capture the profile with these options, as a link or as an update. */
const paths = {
  async submit(c: CaptureContext, body?: OptionsBody) {
    const job = captureURL(c, PROFILE, undefined, resolveOptions(body))
    await c.queue.drain()
    return recordDetail(c.db, job.submissionId)
  },
  async update(c: CaptureContext, body?: OptionsBody) {
    const { collectionId } = captureURL(
      c,
      PROFILE,
      undefined,
      resolveOptions({ posts: 'none' }),
    )
    await c.queue.drain()
    const id = startUpdate(
      c,
      { target: 'collection', id: collectionId },
      { options: resolveOptions(body) },
    )
    await c.queue.drain()
    return updateRecord(c.db, id)
  },
}

describe.each(['submit', 'update'] as const)('options when %s', (path) => {
  const run = paths[path]

  test('the defaults: the newest 100, everything kept', async () => {
    const c = setup()
    const record = await run(c)
    expect(saved(c)).toEqual({
      posts: [1, 2, 3, 4, 5, 6],
      references: [1002, 1003, 1006],
    })
    expect(record.options).toEqual(DEFAULT_OPTIONS)
  })

  test('the newest N count posts as listed', async () => {
    const c = setup()
    await run(c, { count: 3, media_only: true })
    expect(saved(c).posts).toEqual([1, 3])
  })

  test('at most N count the posts kept, reading on until them', async () => {
    const c = setup()
    await run(c, { posts: 'max', count: 3, media_only: true })
    // 1 and 3 on the first page, 5 on the second; the page is kept whole.
    expect(saved(c).posts).toEqual([1, 3, 5, 6])
  })

  test('media only', async () => {
    const c = setup()
    await run(c, { media_only: true })
    expect(saved(c)).toEqual({
      posts: [1, 3, 5, 6],
      references: [1003, 1006],
    })
  })

  test('without quotes and reposts', async () => {
    const c = setup()
    await run(c, { include_shared: false })
    expect(saved(c)).toEqual({ posts: [1, 4, 5], references: [] })
  })

  test('without the posts they refer to', async () => {
    const c = setup()
    const record = await run(c, { capture_references: false })
    // A pure repost is the original itself.
    expect(saved(c)).toEqual({ posts: [1, 2, 4, 5, 6], references: [] })
    expect(record.options).toMatchObject({ captureReferences: false })
  })

  test('a date range', async () => {
    const c = setup()
    const record = await run(c, { since_days: 7 })
    expect(saved(c).posts).toEqual([1, 2, 3])
    expect(record.options).toMatchObject({ sinceDays: 7 })
  })

  test('no posts', async () => {
    const c = setup()
    await run(c, { posts: 'none' })
    expect(saved(c).posts).toEqual([])
  })

  test('the lists', async () => {
    const c = setup()
    const record = await run(c, { posts: 'none', relations: true })
    expect(record.options).toMatchObject({ relations: true })
    expect(
      c.db
        .select({ list: relationFetches.list })
        .from(relationFetches)
        .all()
        .map((row) => row.list),
    ).toEqual(['following', 'followers'])
  })
})

describe('until saved posts, from a link', () => {
  test('stops at saved posts and one page more', async () => {
    const timeline = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      type: 'post' as const,
      media: true,
      age: i,
    }))
    const c = setup(timeline)
    captureURL(c, 'https://fake.test/p/5')
    await c.queue.drain()
    await paths.submit(c, { posts: 'until_existing' })
    // Pages 1–3, 4–6 (holds the saved 5) and one more, 7–9.
    expect(saved(c).posts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('continuing keeps the options', () => {
  // Media on odd posts; a cap of 3 stops each read after a page.
  const timeline = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    type: 'post' as const,
    media: i % 2 === 0,
    age: i,
  }))

  test('a link submission continues in its own record', async () => {
    const c = setup(timeline, 3)
    const record = await paths.submit(c, {
      posts: 'until_existing',
      media_only: true,
    })
    expect(record.pages).toMatchObject({ capped: true })
    expect(saved(c).posts).toEqual([1, 3])
    recordPage(c, record.id, 'continue')
    await c.queue.drain()
    expect(saved(c).posts).toEqual([1, 3, 5])
    const pages = c.db
      .select({ options: submissions.captureOptions })
      .from(submissions)
      .where(eq(submissions.parentSubmission, record.id))
      .all()
      .filter((row) => row.options?.posts === 'until_existing')
    expect(pages.map((p) => p.options?.mediaOnly)).toContain(true)
    expect(recordDetail(c.db, record.id).options).toEqual(record.options)
  })

  test('an update continues in its own record', async () => {
    const c = setup(timeline, 3)
    const record = await paths.update(c, {
      posts: 'until_existing',
      media_only: true,
    })
    const profile = updateDetail(c.db, record.id).profiles[0]!
    expect(profile.posts).toMatchObject({ capped: true })
    continueTimeline(c, record.id, profile.collectionId)
    await c.queue.drain()
    expect(saved(c).posts).toEqual([1, 3, 5])
    expect(updateRecord(c.db, record.id).options).toMatchObject({
      posts: 'until_existing',
      mediaOnly: true,
    })
  })
})

describe('a single post', () => {
  test('captures its references unless told not to, as a link or update', async () => {
    const c = setup()
    const quote = captureURL(
      c,
      'https://fake.test/p/2',
      undefined,
      resolveOptions({ capture_references: false }),
    )
    await c.queue.drain()
    expect(saved(c).references).toEqual([])
    startUpdate(
      c,
      { target: 'collection', id: quote.collectionId },
      { options: resolveOptions({ capture_references: false }) },
    )
    await c.queue.drain()
    expect(saved(c).references).toEqual([])
    startUpdate(c, { target: 'collection', id: quote.collectionId })
    await c.queue.drain()
    expect(saved(c).references).toEqual([1002])
  })
})

describe('older posts', () => {
  test('read on from the last page with the options', async () => {
    const c = setup()
    const { collectionId } = captureURL(
      c,
      PROFILE,
      undefined,
      resolveOptions({ count: 3 }),
    )
    await c.queue.drain()
    startUpdate(
      c,
      { target: 'collection', id: collectionId },
      { options: resolveOptions({ media_only: true }), older: true },
    )
    await c.queue.drain()
    expect(saved(c).posts).toEqual([1, 2, 3, 5, 6])
    expect(() =>
      startUpdate(
        c,
        { target: 'collection', id: collectionId },
        { options: resolveOptions({ posts: 'none' }), older: true },
      ),
    ).toThrow('不支持')
  })
})
