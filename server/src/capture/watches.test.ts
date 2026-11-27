import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  collections,
  jobs,
  telegramDeliveries,
  updates,
  watches,
} from '#db/schema.ts'
import { deleteCollections } from '#library/delete.ts'
import { createFolder, deleteFolder } from '#library/folders.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { captureURL } from './records.ts'
import { pauseUpdate, resumeUpdate, updateRecord } from './updates.ts'
import {
  editWatch,
  listWatches,
  MAX_RUNS,
  runWatches,
  setWatch,
  watchNextRun,
} from './watches.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchRequest } from '#platforms/protocol.ts'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const SIX_HOURS = { count: 6, unit: 'hour' } as const
const DAILY = { count: 1, unit: 'day' } as const
const WEEKLY = { count: 1, unit: 'week' } as const
const START = Date.parse('2026-11-26T00:00:00Z')

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const listed = (id: number) => ({
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

/** Profiles list posts 1–6, three a page; the clock moves by hand. */
function setup(options: { run?: boolean } = {}) {
  const clock = { now: START }
  const requests: FetchRequest[] = []
  ctx = testContext({
    now: () => clock.now,
    platforms: [
      fakePlatform({
        current: (req) => {
          requests.push(req)
          if (req.kind === 'post')
            return { text: 'post', graph: postGraph(req.externalId, {}) }
          const start = Number(req.pageCursor || 0)
          const posts = [1, 2, 3, 4, 5, 6]
          return {
            ...fakeProfile(req.externalId, {
              username: `u${req.externalId}`,
            }),
            providerId: req.providerId,
            relatedTargets: posts.slice(start, start + 3).map(listed),
            nextPageCursor: start + 3 < posts.length ? String(start + 3) : '',
          }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  if (options.run !== false) ctx.queue.start()
  return { ctx, clock, requests }
}

async function save(c: AccountsContext, url: string) {
  const job = captureURL(c, url, undefined, resolveOptions({ posts: 'none' }))
  await c.queue.drain()
  return job.collectionId
}

/** Run every job, moving the clock past the delayed ones (snoozes). */
async function settle(c: AccountsContext, clock: { now: number }) {
  for (let i = 0; i < 100; i++) {
    await c.queue.drain()
    if (!c.db.select().from(jobs).all().length) return
    clock.now += 10_000
  }
  throw new Error('jobs left')
}

const watchRow = (c: AccountsContext, id: string) =>
  c.db.select().from(watches).where(eq(watches.id, id)).get()!

const watchRuns = (c: AccountsContext) =>
  c.db.select().from(updates).where(eq(updates.origin, 'watch')).all()

describe('定期更新', () => {
  test('a profile or a folder; one watch per target', async () => {
    const { ctx } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const post = await save(ctx, 'https://fake.test/p/9')
    const folder = createFolder(ctx.db, { name: '猫', filter: '' })
    const options = resolveOptions({})
    const id = setWatch(
      ctx,
      { target: 'collection', id: profile },
      { every: DAILY, options },
    )
    expect(watchRow(ctx, id).nextRunAt.getTime()).toBe(
      watchNextRun(watchRow(ctx, id), START),
    )
    expect(() =>
      setWatch(
        ctx!,
        { target: 'collection', id: post },
        { every: DAILY, options },
      ),
    ).toThrow('只能定期更新账号或收藏夹')
    setWatch(
      ctx,
      { target: 'folder', id: folder.id },
      { every: WEEKLY, options },
    )
    // Watching again edits the same watch, from the new interval's slot.
    expect(
      setWatch(
        ctx,
        { target: 'collection', id: profile },
        { every: SIX_HOURS, options: resolveOptions({ relations: true }) },
      ),
    ).toBe(id)
    expect(watchRow(ctx, id)).toMatchObject({
      everyCount: 6,
      everyUnit: 'hour',
      options: { relations: true },
      nextRunAt: new Date(watchNextRun(watchRow(ctx, id), START)),
    })
    expect(
      listWatches(ctx.db).map((w) => [w.target, w.name || w.handle]),
    ).toEqual([
      ['collection', 'u100'],
      ['folder', '猫'],
    ])
  })

  test('a due watch runs as an ordinary update with its own options, and tells nobody', async () => {
    const { ctx, clock, requests } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const id = setWatch(
      ctx,
      { target: 'collection', id: profile },
      {
        every: DAILY,
        options: resolveOptions({ count: 3, include_shared: false }),
      },
    )
    // Not due yet.
    expect(runWatches(ctx).started).toEqual([])
    clock.now = watchRow(ctx, id).nextRunAt.getTime()
    requests.length = 0
    const tick = runWatches(ctx)
    expect(tick.started).toHaveLength(1)
    const run = tick.started[0]!.updateId
    const ranAt = clock.now
    expect(
      ctx.db.select().from(updates).where(eq(updates.id, run)).get(),
    ).toMatchObject({
      origin: 'watch',
      watchId: id,
      target: 'collection',
      targetId: profile,
      options: { posts: 'latest', count: 3, includeShared: false },
    })
    // Its jobs rank as a watch's.
    expect(
      ctx.db
        .select({ priority: jobs.priority })
        .from(jobs)
        .where(eq(jobs.updateId, run))
        .all(),
    ).toEqual([{ priority: 2 }])
    await settle(ctx, clock)
    expect(updateRecord(ctx.db, run)).toMatchObject({
      done: true,
      state: 'complete',
      update: { watch: true, profiles: 1 },
    })
    // The first page of three, as the options say.
    expect(
      requests.filter((r) => r.kind === 'post').map((r) => r.externalId),
    ).toEqual(['1', '2', '3'])
    expect(ctx.db.select().from(telegramDeliveries).all()).toEqual([])
    expect(listWatches(ctx.db)[0]).toMatchObject({
      nextRunAt: new Date(ranAt + DAY),
      lastRun: { id: run, state: 'complete', done: true },
    })
  })

  test('a slot whose last run still goes is skipped', async () => {
    const { ctx, clock } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const id = setWatch(
      ctx,
      { target: 'collection', id: profile },
      { every: SIX_HOURS, options: resolveOptions({}) },
    )
    clock.now = watchRow(ctx, id).nextRunAt.getTime()
    const [first] = runWatches(ctx).started
    pauseUpdate(ctx, first!.updateId)

    clock.now += 6 * HOUR
    expect(runWatches(ctx)).toMatchObject({ started: [], skipped: [id] })
    expect(watchRuns(ctx)).toHaveLength(1)
    expect(watchRow(ctx, id).nextRunAt.getTime()).toBe(clock.now + 6 * HOUR)

    // Over, the next slot runs again.
    resumeUpdate(ctx, first!.updateId)
    await settle(ctx, clock)
    clock.now += 6 * HOUR
    expect(runWatches(ctx).started).toHaveLength(1)
    expect(watchRuns(ctx)).toHaveLength(2)
  })

  test('after downtime a watch runs once, not once per missed slot', async () => {
    const { ctx, clock } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const id = setWatch(
      ctx,
      { target: 'collection', id: profile },
      { every: SIX_HOURS, options: resolveOptions({}) },
    )
    // Ten days down: forty slots passed.
    clock.now = watchRow(ctx, id).nextRunAt.getTime() + 10 * 24 * HOUR + 1234
    expect(runWatches(ctx).started).toHaveLength(1)
    await settle(ctx, clock)
    expect(runWatches(ctx).started).toEqual([])
    expect(watchRuns(ctx)).toHaveLength(1)
    const next = watchRow(ctx, id).nextRunAt.getTime()
    expect(next).toBe(watchNextRun(watchRow(ctx, id), clock.now))
    expect(next - clock.now).toBeLessThanOrEqual(6 * HOUR)
  })

  test(`at most ${MAX_RUNS} watch runs go at once; the others wait, still due`, async () => {
    const { ctx, clock } = setup()
    const ids = []
    for (let i = 0; i < MAX_RUNS + 1; i++) {
      const profile = await save(ctx, `https://fake.test/u/${100 + i}`)
      ids.push(
        setWatch(
          ctx,
          { target: 'collection', id: profile },
          { every: DAILY, options: resolveOptions({}) },
        ),
      )
    }
    await ctx.queue.stop()
    clock.now += DAY
    const tick = runWatches(ctx)
    expect(tick.started).toHaveLength(MAX_RUNS)
    expect(tick.waiting).toHaveLength(1)
    const [waiting] = tick.waiting
    expect(watchRow(ctx, waiting!).nextRunAt.getTime()).toBeLessThanOrEqual(
      clock.now,
    )
    expect(runWatches(ctx).waiting).toEqual([waiting])
  })

  test('the waiting watch starts once a run ends', async () => {
    const { ctx, clock } = setup()
    const ids = []
    for (let i = 0; i < MAX_RUNS + 1; i++) {
      const profile = await save(ctx, `https://fake.test/u/${100 + i}`)
      ids.push(
        setWatch(
          ctx,
          { target: 'collection', id: profile },
          { every: DAILY, options: resolveOptions({}) },
        ),
      )
    }
    clock.now += DAY
    const { waiting } = runWatches(ctx)
    await settle(ctx, clock)
    clock.now += 60_000
    expect(runWatches(ctx).started.map((s) => s.watchId)).toEqual(waiting)
  })

  test('a slot that cannot start says why, and the next one tries again', async () => {
    const { ctx, clock } = setup()
    const folder = createFolder(ctx.db, { name: '空', filter: 'q=nothing' })
    const id = setWatch(
      ctx,
      { target: 'folder', id: folder.id },
      { every: DAILY, options: resolveOptions({}) },
    )
    clock.now = watchRow(ctx, id).nextRunAt.getTime()
    expect(runWatches(ctx).failed).toEqual([id])
    expect(watchRow(ctx, id)).toMatchObject({
      error: '收藏夹是空的',
      nextRunAt: new Date(clock.now + DAY),
    })
  })

  test('turned off it does not run; turned on it starts from its next slot', async () => {
    const { ctx, clock } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const id = setWatch(
      ctx,
      { target: 'collection', id: profile },
      { every: DAILY, options: resolveOptions({}) },
    )
    editWatch(ctx, id, { enabled: false })
    clock.now += 3 * DAY
    expect(runWatches(ctx).started).toEqual([])
    editWatch(ctx, id, { enabled: true })
    expect(watchRow(ctx, id).nextRunAt.getTime()).toBe(
      watchNextRun(watchRow(ctx, id), clock.now),
    )
    expect(runWatches(ctx).started).toEqual([])
  })

  test('removing the profile or the folder removes its watch', async () => {
    const { ctx, clock } = setup()
    const profile = await save(ctx, 'https://fake.test/u/100')
    const folder = createFolder(ctx.db, { name: '猫', filter: '' })
    const onProfile = setWatch(
      ctx,
      { target: 'collection', id: profile },
      { every: DAILY, options: resolveOptions({}) },
    )
    setWatch(
      ctx,
      { target: 'folder', id: folder.id },
      { every: DAILY, options: resolveOptions({}) },
    )
    clock.now = watchRow(ctx, onProfile).nextRunAt.getTime()
    const run = runWatches(ctx).started.find((s) => s.watchId === onProfile)
    await ctx.queue.drain()

    deleteCollections(ctx.db, [profile])
    expect(listWatches(ctx.db).map((w) => w.target)).toEqual(['folder'])
    // Its runs stay, still marked as a watch's.
    expect(
      ctx.db.select().from(updates).where(eq(updates.id, run!.updateId)).get(),
    ).toMatchObject({ origin: 'watch', watchId: null })
    deleteFolder(ctx.db, folder.id)
    expect(listWatches(ctx.db)).toEqual([])
    expect(ctx.db.select().from(collections).all().length).toBeGreaterThan(0)
  })
})
