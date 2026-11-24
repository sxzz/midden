import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { collections } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions, type OptionsBody } from './options.ts'
import { captureURL, recordDetail } from './records.ts'
import { startUpdate, updateDetail } from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const DAY = 86_400_000
const PROFILE = 'https://fake.test/u/100'

interface Entry {
  id: number
  /** Days since it appeared on the timeline; null when unknown. */
  listed: number | null
  /** Days since it was published; the listing age by default. */
  published?: number
  pinned?: boolean
  repost?: boolean
}

const post = (id: number, listed: number | null, extra = {}): Entry => ({
  id,
  listed,
  ...extra,
})

/** A profile whose timeline pages are these, newest first. */
function setup(pages: Entry[][], timelineCap?: number) {
  const now = Date.now()
  const iso = (days: number | null | undefined) =>
    days === null || days === undefined
      ? ''
      : new Date(now - days * DAY).toISOString()
  const reads: { cursor: string; since: string }[] = []
  const c = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          if (req.kind === 'post')
            return { text: 'post', graph: postGraph(req.externalId, {}) }
          const page = Number(req.pageCursor || 0)
          reads.push({ cursor: req.pageCursor, since: req.since })
          return {
            ...fakeProfile(req.externalId),
            relatedTargets: pages[page]!.map((entry) => ({
              url: `https://fake.test/p/${entry.id}`,
              refreshAfterSeconds: 0,
              updatedAt: '',
              publishedAt: iso(entry.published ?? entry.listed),
              listedAt: iso(entry.listed),
              pinned: !!entry.pinned,
              mediaTypes: [],
              postType: entry.repost ? 'repost' : 'post',
              prefetch: Buffer.alloc(0),
            })),
            nextPageCursor: page + 1 < pages.length ? String(page + 1) : '',
            maxBatchSize: 1000,
          }
        },
      }),
    ],
    handlers: captureHandlers,
    timelineCap,
  })
  ctx = c
  c.queue.start()
  return { c, reads }
}

function saved(c: CaptureContext) {
  return c.db
    .select({ id: collections.externalId })
    .from(collections)
    .where(eq(collections.kind, 'post'))
    .all()
    .map((row) => Number(row.id))
    .toSorted((a, b) => a - b)
}

async function capture(c: CaptureContext, body: OptionsBody) {
  const job = captureURL(c, PROFILE, undefined, resolveOptions(body))
  await c.queue.drain()
  return recordDetail(c.db, job.submissionId)
}

const ALL = { posts: 'max', since_days: 7 } as const

describe('a date range stops the paging', () => {
  test('at the first page entirely older than the cutoff', async () => {
    const { c, reads } = setup([
      [post(1, 1), post(2, 2)],
      [post(3, 3), post(4, 4)],
      [post(5, 10), post(6, 11)],
      [post(7, 12)],
    ])
    const record = await capture(c, ALL)
    expect(reads.map((r) => r.cursor)).toEqual(['', '1', '2'])
    // The platform is told the cutoff, to stop within a page too.
    expect(reads.every((r) => r.since)).toBe(true)
    expect(saved(c)).toEqual([1, 2, 3, 4])
    // The run ends complete, not stopped, with nothing to continue.
    expect(record).toMatchObject({ state: 'complete', done: true })
    expect(record.stopped).toBe(false)
    expect(record.pages).toMatchObject({ capped: false, more: true })
  })

  test('not at an old pinned post', async () => {
    const { c, reads } = setup([
      [post(1, 300, { pinned: true }), post(2, null)],
      [post(3, 2)],
      [post(4, 10)],
      [post(5, 11)],
    ])
    await capture(c, ALL)
    expect(reads.map((r) => r.cursor)).toEqual(['', '1', '2'])
    expect(saved(c)).toEqual([3])
  })

  test('after a page crossing the cutoff, keeping its newer posts', async () => {
    const { c, reads } = setup([
      [post(1, 1), post(2, 2)],
      [post(3, 3), post(4, 10)],
      [post(5, 11)],
    ])
    await capture(c, ALL)
    expect(reads.map((r) => r.cursor)).toEqual(['', '1'])
    expect(saved(c)).toEqual([1, 2, 3])
  })

  test('never while times are unknown', async () => {
    const { c, reads } = setup([
      [post(1, null, { published: 20 })],
      [post(2, null, { published: 30 })],
      [post(3, null, { published: 40 })],
    ])
    await capture(c, ALL)
    expect(reads).toHaveLength(3)
    expect(saved(c)).toEqual([])
  })

  test('by when a repost was reposted, not when the original was posted', async () => {
    const { c, reads } = setup([
      [post(1, 1, { published: 300, repost: true })],
      [post(2, 2)],
      [post(3, 10)],
      [post(4, 11)],
    ])
    await capture(c, ALL)
    expect(reads.map((r) => r.cursor)).toEqual(['', '1', '2'])
    // The filter still goes by publication.
    expect(saved(c)).toEqual([2])
  })

  test('the newest N stop early too', async () => {
    const { c, reads } = setup([[post(1, 1)], [post(2, 10)], [post(3, 11)]])
    await capture(c, { count: 100, since_days: 7 })
    expect(reads).toHaveLength(2)
  })
})

describe('until saved posts with a date range', () => {
  test('saved posts first: one page more, then stop', async () => {
    const { c, reads } = setup([
      [post(1, 1)],
      [post(2, 2)],
      [post(3, 3)],
      [post(4, 4)],
      [post(5, 10)],
    ])
    captureURL(c, 'https://fake.test/p/2')
    await c.queue.drain()
    await capture(c, { posts: 'until_existing', since_days: 7 })
    expect(reads.map((r) => r.cursor)).toEqual(['', '1', '2'])
  })

  test('the date first: stop there', async () => {
    const { c, reads } = setup([
      [post(1, 1)],
      [post(2, 10)],
      [post(3, 11)],
      [post(4, 12)],
    ])
    captureURL(c, 'https://fake.test/p/4')
    await c.queue.drain()
    await capture(c, { posts: 'until_existing', since_days: 7 })
    expect(reads.map((r) => r.cursor)).toEqual(['', '1'])
  })

  test('a date stop at the post cap leaves nothing to continue', async () => {
    // A cap of 2 would stop after the first page, continuable.
    const pages = [
      [post(1, 1), post(2, 10)],
      [post(3, 11), post(4, 12)],
    ]
    const link = setup(pages, 2)
    const record = await capture(link.c, {
      posts: 'until_existing',
      since_days: 7,
    })
    expect(link.reads).toHaveLength(1)
    expect(record.pages).toMatchObject({ capped: false })
    expect(record.state).toBe('complete')
    await ctx!.queue.stop()

    const update = setup(pages, 2)
    const { collectionId } = captureURL(
      update.c,
      PROFILE,
      undefined,
      resolveOptions({ posts: 'none' }),
    )
    await update.c.queue.drain()
    const id = startUpdate(
      update.c,
      { target: 'collection', id: collectionId },
      { options: resolveOptions({ posts: 'until_existing', since_days: 7 }) },
    )
    await update.c.queue.drain()
    const detail = updateDetail(update.c.db, id)
    expect(detail.profiles[0]!.posts).toMatchObject({
      done: true,
      capped: false,
    })
    expect(detail).toMatchObject({ state: 'complete', done: true })
  })

  test('without a date range the cap is still continuable', async () => {
    const { c } = setup([[post(1, 1), post(2, 10)], [post(3, 11)]], 2)
    const record = await capture(c, { posts: 'until_existing' })
    expect(record.pages).toMatchObject({ capped: true })
  })
})
