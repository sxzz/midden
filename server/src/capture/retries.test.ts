import { Buffer } from 'node:buffer'
import { and, desc, eq, gt } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount, type AccountsContext } from '#accounts/accounts.ts'
import {
  assets,
  captures,
  collections,
  jobs,
  relationFetches,
  revisions,
  submissions,
} from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  fakeProfile,
  postGraph,
} from '#testing/fake-platform.ts'
import { JPEG } from '#testing/library.ts'
import { captureHandlers } from './handlers.ts'
import { DEFAULT_OPTIONS, type CaptureOptions } from './options.ts'
import {
  captureURL,
  collectionProgress,
  recordDetail,
  recordMembers,
} from './records.ts'
import { retryPlan, retryRecordFailed } from './retries.ts'
import {
  pauseUpdate,
  recordProfiles,
  resumeUpdate,
  startUpdate,
  updateDetail,
  updateMembers,
  updateRecord,
} from './updates.ts'
import type { RelationsRequest } from '#platforms/platform.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const target = (id: number) => ({
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

const PROFILE = 'https://fake.test/u/100'
const media = (id: string) => `https://m.test/p${id}.jpg`
const AVATAR = 'https://m.test/avatar.jpg'

/**
 * A profile (`100`) with two pages of two posts each, every post with one
 * image, and a following list of four, two to a page. Each set breaks
 * what it names until cleared.
 */
function setup(
  options: { public?: boolean; followers?: number; following?: number } = {},
) {
  const world = {
    brokenPosts: new Set<string>(),
    /** Page cursors whose fetch fails. */
    brokenPages: new Set<string>(),
    brokenMedia: new Set<string>(),
    listFail: undefined as
      ((req: RelationsRequest) => Error | undefined) | undefined,
    /** Posts and pages (`page:<cursor>`) fetched, in order. */
    fetched: [] as string[],
    downloaded: [] as string[],
    listed: [] as RelationsRequest[],
  }
  ctx = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            if (req.kind === 'post') {
              world.fetched.push(req.externalId)
              if (world.brokenPosts.has(req.externalId))
                throw new FakeFailure(
                  status.FAILED_PRECONDITION,
                  '帖子暂不可见',
                )
              return {
                text: `post ${req.externalId}`,
                resources: [
                  {
                    kind: 'image',
                    url: media(req.externalId),
                    immutableKey: '',
                    altText: '',
                    sensitive: false,
                    purpose: '',
                  },
                ],
                graph: postGraph(req.externalId, { text: 'x' }, undefined, {
                  resourceIndices: [0],
                }),
              }
            }
            const cursor = req.pageCursor || ''
            world.fetched.push(`page:${cursor}`)
            if (world.brokenPages.has(cursor))
              throw new FakeFailure(
                status.FAILED_PRECONDITION,
                '时间线读取失败',
              )
            const page = Number(cursor || 0)
            return {
              ...fakeProfile(
                req.externalId,
                {
                  name: 'Someone',
                  metadata: {
                    following: options.following ?? 4,
                    followers: options.followers ?? 0,
                  },
                  ...(options.public === false ? {} : { protected: false }),
                },
                { avatar: AVATAR },
              ),
              providerId: req.providerId,
              relatedTargets: [target(page * 2 + 1), target(page * 2 + 2)],
              nextPageCursor: page === 0 ? '1' : '',
              maxBatchSize: 1000,
            }
          },
        },
        {
          current: (req) => {
            world.listed.push(req)
            const error = world.listFail?.(req)
            if (error) throw error
            const all = req.list === 'following' ? ['1', '2', '3', '4'] : []
            const start = Number(req.cursor || 0)
            return {
              accounts: all
                .slice(start, start + 2)
                .map((id) => fakeProfile(id, { name: `Name ${id}` })),
              nextCursor: start + 2 < all.length ? String(start + 2) : '',
            }
          },
        },
      ),
    ],
    handlers: captureHandlers,
    fetch: async (input) => {
      const url = String(input)
      world.downloaded.push(url)
      return world.brokenMedia.has(url)
        ? new Response(null, { status: 404 })
        : new Response(JPEG)
    },
  })
  ctx.queue.start()
  return { ctx, world }
}

const fourPosts: CaptureOptions = { ...DEFAULT_OPTIONS, count: 4 }

async function captureProfile(c: AccountsContext, relations = false) {
  const job = captureURL(c, PROFILE, undefined, { ...fourPosts, relations })
  await c.queue.drain()
  return job.submissionId
}

/** The newest capture of a post. */
function postCapture(c: AccountsContext, id: string) {
  return c.db
    .select({ capture: captures })
    .from(captures)
    .innerJoin(collections, eq(collections.id, captures.collectionId))
    .where(eq(collections.url, `https://fake.test/p/${id}`))
    .orderBy(captures.createdAt)
    .all()
    .at(-1)!.capture
}

const list = (c: AccountsContext) =>
  c.db
    .select()
    .from(relationFetches)
    .where(eq(relationFetches.list, 'following'))
    .get()!

function reset(world: ReturnType<typeof setup>['world']) {
  world.fetched = []
  world.downloaded = []
  world.listed = []
}

describe('retrying what failed in a record', () => {
  test('a post missing media downloads only that media again, in place', async () => {
    const { ctx, world } = setup()
    world.brokenMedia.add(media('1'))
    const record = await captureProfile(ctx)
    const partial = postCapture(ctx, '1')
    expect(partial.state).toBe('partial')
    const revision = ctx.db
      .select()
      .from(revisions)
      .where(eq(revisions.captureId, partial.id))
      .get()!
    let detail = recordDetail(ctx.db, record)
    expect(detail.members).toMatchObject({ complete: 3, partial: 1 })
    expect(detail.retryable).toBe(1)
    expect(
      recordMembers(ctx.db, record, 'problem').items.map((m) => [
        m.jobId,
        m.retryable,
      ]),
    ).toEqual([[partial.id, true]])

    // Still broken: the retry fails again and leaves it as it was.
    reset(world)
    expect(retryRecordFailed(ctx, record, partial.id)).toBe(1)
    // Already being retried: asking again queues nothing.
    expect(retryRecordFailed(ctx, record, partial.id)).toBe(0)
    expect(retryRecordFailed(ctx, record)).toBe(0)
    expect(
      ctx.db.select().from(jobs).where(eq(jobs.type, 'download')).all(),
    ).toHaveLength(1)
    expect(recordDetail(ctx.db, record).done).toBe(false)
    await ctx.queue.drain()
    expect(world.downloaded).toEqual([media('1')])
    expect(postCapture(ctx, '1')).toMatchObject({
      id: partial.id,
      state: 'partial',
    })
    expect(recordDetail(ctx.db, record).retryable).toBe(1)

    world.brokenMedia.clear()
    reset(world)
    expect(retryRecordFailed(ctx, record)).toBe(1)
    await ctx.queue.drain()
    // Nothing fetched again: only the missing image downloaded.
    expect(world.fetched).toEqual([])
    expect(world.downloaded).toEqual([media('1')])
    const repaired = postCapture(ctx, '1')
    expect(repaired).toMatchObject({ id: partial.id, state: 'complete' })
    expect(
      ctx.db
        .select({ state: assets.state })
        .from(assets)
        .where(eq(assets.captureId, partial.id))
        .all(),
    ).toEqual([{ state: 'ready' }])
    // Its revision shows the image now, and stays the current one.
    const after = ctx.db
      .select()
      .from(revisions)
      .where(eq(revisions.collectionId, partial.collectionId))
      .all()
    expect(after.map((r) => r.id)).toEqual([revision.id])
    expect(after[0]!.contentHash).not.toBe(revision.contentHash)
    expect(
      ctx.db
        .select({ current: collections.currentRevision })
        .from(collections)
        .where(eq(collections.id, partial.collectionId))
        .get()!.current,
    ).toBe(revision.id)
    detail = recordDetail(ctx.db, record)
    expect(detail).toMatchObject({ done: true, retryable: 0 })
    expect(detail.members).toMatchObject({ complete: 4, partial: 0 })
  })

  test("a record's own missing media, and a new capture meanwhile is its own", async () => {
    const { ctx, world } = setup()
    world.brokenMedia.add(AVATAR)
    const record = await captureProfile(ctx)
    let detail = recordDetail(ctx.db, record)
    expect(detail).toMatchObject({
      state: 'partial',
      mediaRetryable: true,
      retryable: 2,
    })
    expect(recordProfiles(ctx.db, detail)).toMatchObject([
      { jobId: detail.jobId, retryable: true, posts: { retryable: 1 } },
    ])
    world.brokenMedia.clear()
    reset(world)
    expect(retryRecordFailed(ctx, record, detail.jobId)).toBe(1)
    // The profile fetched anew while its avatar downloads again: a fetch
    // of its own, not the retry's.
    const job = captureURL(ctx, PROFILE, undefined, fourPosts)
    expect(job.id).not.toBe(detail.jobId)
    await ctx.queue.drain()
    detail = recordDetail(ctx.db, record)
    expect(detail).toMatchObject({ state: 'complete', mediaRetryable: false })
    // The later page still misses it; the profile's posts retry it.
    expect(detail.retryable).toBe(1)
  })

  test('a failed post is fetched again by its page, alone', async () => {
    const { ctx, world } = setup()
    world.brokenPosts.add('2')
    const record = await captureProfile(ctx)
    const failed = postCapture(ctx, '2')
    expect(recordDetail(ctx.db, record)).toMatchObject({
      retryable: 1,
      members: { failed: 1 },
    })
    expect(recordMembers(ctx.db, record, 'problem').items).toMatchObject([
      { jobId: failed.id, state: 'failed', retryable: true },
    ])
    world.brokenPosts.clear()
    reset(world)
    expect(retryRecordFailed(ctx, record, failed.id)).toBe(1)
    expect(retryRecordFailed(ctx, record, failed.id)).toBe(0)
    await ctx.queue.drain()
    expect(world.fetched).toEqual(['2'])
    expect(recordDetail(ctx.db, record)).toMatchObject({
      retryable: 0,
      members: { complete: 4, failed: 0 },
    })
  })

  test('a failed page is fetched again in its place in the record', async () => {
    const { ctx, world } = setup()
    world.brokenPages.add('1')
    const record = await captureProfile(ctx)
    let detail = recordDetail(ctx.db, record)
    expect(detail.members).toMatchObject({ total: 2, complete: 2 })
    expect(detail.retryable).toBe(1)
    const [part] = recordProfiles(ctx.db, detail)
    const page = collectionProgress(ctx.db, record).pages[1]!
    expect(part!.posts).toMatchObject({
      retryable: 1,
      retryId: `posts:${record}`,
      pages: [{ id: page.submission.id, number: 2, error: '时间线读取失败' }],
    })

    world.brokenPages.clear()
    reset(world)
    expect(retryRecordFailed(ctx, record, page.submission.id)).toBe(1)
    expect(retryRecordFailed(ctx, record, page.submission.id)).toBe(0)
    await ctx.queue.drain()
    // That page and its posts; the first page and its posts are kept.
    expect(world.fetched).toEqual(['page:1', '3', '4'])
    const pages = collectionProgress(ctx.db, record).pages
    expect(pages.map((p) => p.capture.state)).toEqual(['complete', 'complete'])
    detail = recordDetail(ctx.db, record)
    expect(detail.members).toMatchObject({ total: 4, complete: 4 })
    expect(detail).toMatchObject({ done: true, retryable: 0 })
  })

  test('a page whose listing failed submits it again', async () => {
    const { ctx, world } = setup()
    const record = await captureProfile(ctx)
    const page = collectionProgress(ctx.db, record).pages[1]!
    // As a related step that failed leaves it (or the Go version's import).
    ctx.db
      .delete(submissions)
      .where(eq(submissions.parentSubmission, page.submission.id))
      .run()
    ctx.db
      .update(submissions)
      .set({ relatedState: 'failed', relatedError: '采集被中断' })
      .where(eq(submissions.id, page.submission.id))
      .run()
    expect(recordDetail(ctx.db, record)).toMatchObject({
      retryable: 1,
      members: { total: 4, complete: 2 },
    })
    reset(world)
    expect(retryRecordFailed(ctx, record, `posts:${record}`)).toBe(1)
    await ctx.queue.drain()
    // Its posts, observed again with it as any page's are.
    expect(world.fetched).toEqual(['3', '4'])
    expect(recordDetail(ctx.db, record)).toMatchObject({
      retryable: 0,
      members: { complete: 4 },
    })
  })

  test('a list that failed partway reads on from where it stopped', async () => {
    const { ctx, world } = setup()
    world.listFail = (req) =>
      req.cursor === '2'
        ? new FakeFailure(status.FAILED_PRECONDITION, '关注列表读取失败')
        : undefined
    const record = await captureProfile(ctx, true)
    const fetch = list(ctx)
    expect(fetch).toMatchObject({ state: 'failed', cursor: '2' })
    const detail = recordDetail(ctx.db, record)
    expect(detail.relations).toMatchObject([
      { id: fetch.id, list: 'following', state: 'failed', retryable: true },
      { list: 'followers', state: 'complete', retryable: false },
    ])
    expect(detail.retryable).toBe(1)

    world.listFail = undefined
    reset(world)
    expect(retryRecordFailed(ctx, record, fetch.id)).toBe(1)
    expect(retryRecordFailed(ctx, record, fetch.id)).toBe(0)
    await ctx.queue.drain()
    expect(world.listed.map((r) => r.cursor)).toEqual(['2'])
    expect(list(ctx)).toMatchObject({ state: 'complete', fetched: 4 })
    expect(recordDetail(ctx.db, record)).toMatchObject({
      retryable: 0,
      done: true,
    })
  })

  test('a list that fell short is fetched again from the start', async () => {
    // The profile counts 20; the list gives four.
    const { ctx, world } = setup({ following: 20 })
    const record = await captureProfile(ctx, true)
    expect(list(ctx)).toMatchObject({ state: 'partial', fetched: 4 })
    reset(world)
    expect(retryRecordFailed(ctx, record, list(ctx).id)).toBe(1)
    await ctx.queue.drain()
    expect(world.listed.map((r) => r.cursor)).toEqual(['', '2'])
    expect(list(ctx)).toMatchObject({ state: 'partial', fetched: 4 })
  })

  test("a protected account's list retried while rate-limited waits without using an attempt", async () => {
    const { ctx, world } = setup({ public: false })
    await addAccount(ctx, 'fake', { credential: Buffer.from('owner') })
    world.listFail = () =>
      new FakeFailure(status.PERMISSION_DENIED, '关注列表读取失败')
    const record = await captureProfile(ctx, true)
    expect(list(ctx)).toMatchObject({ state: 'failed' })
    world.listFail = () =>
      new FakeFailure(status.UNAVAILABLE, '关注列表的两个 X 接口均已限流', {
        'retry-after': '600',
        'rate-limited': '1',
      })
    expect(retryRecordFailed(ctx, record, list(ctx).id)).toBe(1)
    await ctx.queue.drain()
    const fetch = list(ctx)
    expect(fetch.state).toBe('running')
    expect(fetch.connectionId).not.toBeNull()
    const row = ctx.db.select().from(jobs).where(eq(jobs.ref, fetch.id)).get()!
    expect(row.attempt).toBe(0)
    expect(row.runAt.getTime() - Date.now()).toBeGreaterThan(500_000)
    // Waiting is a retry under way, not a failure to retry.
    expect(retryRecordFailed(ctx, record, fetch.id)).toBe(0)
  })

  test('retrying all covers every kind at once, each once', async () => {
    const { ctx, world } = setup()
    world.brokenMedia.add(media('1'))
    world.brokenPosts.add('2')
    world.brokenPages.add('1')
    world.listFail = (req) =>
      req.cursor === '2'
        ? new FakeFailure(status.FAILED_PRECONDITION, '关注列表读取失败')
        : undefined
    const record = await captureProfile(ctx, true)
    expect(recordDetail(ctx.db, record).retryable).toBe(4)
    world.brokenMedia.clear()
    world.brokenPosts.clear()
    world.brokenPages.clear()
    world.listFail = undefined
    reset(world)
    expect(retryRecordFailed(ctx, record)).toBe(4)
    expect(retryRecordFailed(ctx, record)).toBe(0)
    await ctx.queue.drain()
    expect(world.fetched.toSorted()).toEqual(['2', '3', '4', 'page:1'])
    expect(world.listed.map((r) => r.cursor)).toEqual(['2'])
    const detail = recordDetail(ctx.db, record)
    expect(detail).toMatchObject({ done: true, retryable: 0 })
    expect(detail.members).toMatchObject({ total: 4, complete: 4 })
    expect(list(ctx).state).toBe('complete')
  })

  test('planned beforehand, a part retried since is not retried again', async () => {
    const { ctx, world } = setup()
    world.brokenMedia.add(media('1'))
    world.brokenPosts.add('2')
    world.brokenPages.add('1')
    world.listFail = (req) =>
      req.cursor === '2'
        ? new FakeFailure(status.FAILED_PRECONDITION, '关注列表读取失败')
        : undefined
    const record = await captureProfile(ctx, true)
    world.brokenMedia.clear()
    world.brokenPosts.clear()
    world.brokenPages.clear()
    world.listFail = undefined
    reset(world)
    // Two requests planned alike, written one after the other.
    const plan = retryPlan(ctx.db, record, undefined)
    const same = retryPlan(ctx.db, record, undefined)
    expect(same).toEqual(plan)
    expect(retryRecordFailed(ctx, record, undefined, plan)).toBe(4)
    expect(retryRecordFailed(ctx, record, undefined, same)).toBe(0)
    await ctx.queue.drain()
    expect(world.fetched.toSorted()).toEqual(['2', '3', '4', 'page:1'])
    expect(world.listed.map((r) => r.cursor)).toEqual(['2'])
    expect(recordDetail(ctx.db, record)).toMatchObject({
      done: true,
      retryable: 0,
    })
  })

  test("an update's items, their posts and lists are retried in the update", async () => {
    const { ctx, world } = setup()
    // Posts listed again reuse what was saved, missing image and all.
    world.brokenMedia.add(media('1'))
    await captureProfile(ctx)
    const post = captureURL(ctx, 'https://fake.test/p/9')
    await ctx.queue.drain()
    const profile = ctx.db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.url, PROFILE))
      .get()!.id
    world.brokenPosts.add('9')
    world.listFail = (req) =>
      req.list === 'following'
        ? new FakeFailure(status.FAILED_PRECONDITION, '关注列表读取失败')
        : undefined
    const update = startUpdate(
      ctx,
      { target: 'many', ids: [profile, post.collectionId] },
      { options: { ...fourPosts, relations: true } },
    )
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({ retryable: 3 })
    const [part] = updateDetail(ctx.db, update).profiles
    expect(part).toMatchObject({
      retryable: false,
      posts: { retryable: 1 },
      relations: [
        { list: 'following', state: 'failed', retryable: true },
        { list: 'followers', state: 'complete', retryable: false },
      ],
    })
    const problems = updateMembers(ctx.db, update, 'problem').items
    expect(
      problems.map((m) => [m.list ?? m.url, m.state, m.retryable]),
    ).toEqual(
      expect.arrayContaining([
        ['https://fake.test/p/1', 'partial', true],
        ['https://fake.test/p/9', 'failed', true],
        ['following', 'failed', true],
      ]),
    )

    world.brokenPosts.clear()
    world.brokenMedia.clear()
    world.listFail = undefined
    reset(world)
    // Earlier captures leave only fallback runs of their pages, due later.
    const before =
      ctx.db.select({ id: jobs.id }).from(jobs).orderBy(desc(jobs.id)).get()
        ?.id ?? 0
    // The profile's posts on their own first.
    expect(retryRecordFailed(ctx, update, part!.posts!.retryId)).toBe(1)
    // What a retry queues is the update's work: paused with it.
    pauseUpdate(ctx, update)
    const stale = retryPlan(ctx.db, update, undefined)
    expect(stale.map((unit) => unit.kind).toSorted()).toEqual(['item', 'list'])
    expect(retryRecordFailed(ctx, update)).toBe(2)
    // Planned before that: the item and the list are retried already.
    expect(retryRecordFailed(ctx, update, undefined, stale)).toBe(0)
    const queued = ctx.db
      .select({ updateId: jobs.updateId, state: jobs.state })
      .from(jobs)
      .where(gt(jobs.id, before))
      .all()
    expect(queued.length).toBeGreaterThan(0)
    expect(queued).toEqual(
      queued.map(() => ({ updateId: update, state: 'paused' })),
    )
    resumeUpdate(ctx, update)
    await ctx.queue.drain()
    // The timeline is not read again: only its missing image.
    expect(world.fetched.filter((f) => f.startsWith('page:'))).toEqual([])
    expect(world.downloaded).toContain(media('1'))
    expect(world.listed.map((r) => [r.list, r.cursor])).toEqual([
      ['following', ''],
      ['following', '2'],
    ])
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      retryable: 0,
      done: true,
    })
  })

  test('nothing stopped is retried', async () => {
    const { ctx, world } = setup()
    world.brokenPosts.add('2')
    const record = await captureProfile(ctx)
    ctx.db
      .update(submissions)
      .set({ collectionStopped: true })
      .where(
        and(
          eq(submissions.id, record),
          eq(submissions.collectionStopped, false),
        ),
      )
      .run()
    expect(recordDetail(ctx.db, record).retryable).toBe(0)
    expect(retryRecordFailed(ctx, record)).toBe(0)
  })
})
