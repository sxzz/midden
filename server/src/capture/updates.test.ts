import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount, type AccountsContext } from '#accounts/accounts.ts'
import { collections, jobs, updates } from '#db/schema.ts'
import { SnoozeError } from '#jobs/queue.ts'
import { createFolder } from '#library/folders.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  fakeProfile,
  postGraph,
  type FakeRelations,
} from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { captureURL } from './records.ts'
import { retryRecordFailed } from './retries.ts'
import {
  collectionUpdate,
  continueTimeline,
  listRecords,
  pauseUpdate,
  previewUpdate,
  resumeUpdate,
  runUpdate,
  startUpdate,
  stopUpdate,
  updateDetail,
  updateMembers,
  updateRecord,
} from './updates.ts'
import type { FetchRequest } from '#platforms/protocol.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** What the fake source says now. */
interface World {
  /** Post ids on each profile's timeline, newest first. */
  timelines: Record<string, number[]>
  pageSize: number
  counts: Record<string, { following: number; followers: number }>
  lists: Record<string, { following?: string[]; followers?: string[] }>
  broken: Set<string>
  requests: FetchRequest[]
}

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

function setup(
  world: Partial<World> = {},
  options: { run?: boolean; timelineCap?: number } = {},
) {
  const state: World = {
    timelines: {},
    pageSize: 3,
    counts: {},
    lists: {},
    broken: new Set(),
    requests: [],
    ...world,
  }
  const relations: FakeRelations = (req) => ({
    accounts: (state.lists[req.externalId]?.[req.list] ?? []).map((id) =>
      fakeProfile(id),
    ),
    nextCursor: '',
  })
  ctx = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            state.requests.push(req)
            if (state.broken.has(req.externalId))
              throw new FakeFailure(status.PERMISSION_DENIED, 'no access')
            if (req.kind === 'post')
              return { text: 'post', graph: postGraph(req.externalId, {}) }
            const id = req.externalId
            const posts = state.timelines[id] ?? []
            const start = Number(req.pageCursor || 0)
            const next = start + state.pageSize
            return {
              ...fakeProfile(id, {
                username: `u${id}`,
                metadata: state.counts[id] ?? { following: 0, followers: 0 },
              }),
              providerId: req.providerId,
              relatedTargets: posts.slice(start, next).map(target),
              nextPageCursor: next < posts.length ? String(next) : '',
            }
          },
        },
        { current: relations },
      ),
    ],
    handlers: captureHandlers,
    timelineCap: options.timelineCap,
  })
  if (options.run !== false) ctx.queue.start()
  return { ctx, state }
}

/** Save a link; a profile with its first page, as the world pages by 3. */
async function save(c: AccountsContext, url: string) {
  const job = captureURL(c, url, undefined, resolveOptions({ count: 3 }))
  await c.queue.drain()
  return job.collectionId
}

/** Post ids saved in the library. */
function savedPosts(c: AccountsContext) {
  return c.db
    .select({ id: collections.externalId })
    .from(collections)
    .where(eq(collections.kind, 'post'))
    .all()
    .map((row) => Number(row.id))
    .toSorted((a, b) => a - b)
}

const records = (c: AccountsContext) => listRecords(c.db).items

/** The jobs an update owns. */
const jobsOf = (c: AccountsContext, update: string) =>
  c.db
    .select({ type: jobs.type, state: jobs.state })
    .from(jobs)
    .where(eq(jobs.updateId, update))
    .all()

describe('更新', () => {
  test('a post updates as one record of its own', async () => {
    const { ctx } = setup()
    const id = await save(ctx, 'https://fake.test/p/1')
    const update = startUpdate(ctx, { target: 'collection', id })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      collectionId: id,
      state: 'complete',
      done: true,
      members: { total: 1, complete: 1, pending: 0, added: 0, updated: 1 },
      update: { target: 'collection', posts: 1, profiles: 0, queued: 0 },
    })
    // The save and the update: the update's capture is no record of its own.
    expect(records(ctx).map((r) => r.id)).toHaveLength(2)
    expect(records(ctx)[0]!.id).toBe(update)
    expect(updateMembers(ctx.db, update, '').items).toMatchObject([
      { collectionId: id, state: 'complete' },
    ])
    expect(collectionUpdate(ctx, id)).toEqual({
      record: { id: update, done: true },
      older: false,
    })
  })

  test('a profile: its newest posts, its lists and how each part went', async () => {
    const { ctx } = setup({
      timelines: { '100': [1, 2, 3, 4, 5] },
      counts: { '100': { following: 2, followers: 6000 } },
      lists: { '100': { following: ['7', '8'] } },
    })
    await addAccount(ctx, 'fake', { credential: Buffer.from('owner') })
    const id = await save(ctx, 'https://fake.test/u/100')
    expect(previewUpdate(ctx, { target: 'collection', id })).toEqual({
      posts: 0,
      profiles: 1,
      listable: 1,
      name: '',
      counts: { following: 2, followers: 6000 },
      older: true,
    })
    const before = records(ctx).length
    const update = startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ count: 3, relations: true }) },
    )
    await ctx.queue.drain()
    // The profile, three posts of its first page and two lists.
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      done: true,
      members: { total: 6, complete: 4, failed: 0, pending: 0 },
      update: {
        profiles: 1,
        handle: 'u100',
        older: false,
      },
    })
    expect(records(ctx)).toHaveLength(before + 1)
    const detail = updateDetail(ctx.db, update)
    expect(detail.profiles).toMatchObject([
      {
        collectionId: id,
        url: 'https://fake.test/u/100',
        handle: 'u100',
        state: 'complete',
        error: '',
        posts: { total: 3, finished: 3, pending: 0, done: true, capped: false },
        relations: [
          { list: 'following', state: 'complete', expected: 2, fetched: 2 },
          {
            list: 'followers',
            state: 'skipped',
            expected: 6000,
            fetched: 0,
            error: '超过 5000 人，未抓取',
          },
        ],
      },
    ])
    // The lists are members too, but a skipped one is no problem.
    expect(updateMembers(ctx.db, update, 'problem').items).toEqual([])
    expect(
      updateMembers(ctx.db, update, '').items.filter((m) => m.list),
    ).toHaveLength(2)
  })

  test('until_existing pages until saved posts, then reads one page more', async () => {
    const { ctx, state } = setup()
    const id = await save(ctx, 'https://fake.test/u/100')
    await save(ctx, 'https://fake.test/p/5')
    state.timelines['100'] = Array.from({ length: 12 }, (_, i) => i + 1)
    state.requests = []
    const update = startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ posts: 'until_existing' }) },
    )
    await ctx.queue.drain()
    // Pages 1–3, 4–6 (holds the saved 5) and one more, 7–9.
    expect(savedPosts(ctx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(
      state.requests
        .filter((r) => r.kind === 'profile')
        .map((r) => r.pageCursor),
    ).toEqual(['', '3', '6'])
    // Saved posts came before the cap.
    expect(updateDetail(ctx.db, update).profiles[0]!.posts).toMatchObject({
      total: 9,
      finished: 9,
      pending: 0,
      done: true,
      capped: false,
    })
    expect(updateRecord(ctx.db, update).members).toMatchObject({
      total: 10,
      added: 8,
      updated: 2,
    })
  })

  test('until_existing stops at the post cap, and continues in the same record', async () => {
    // Pages of 4 against a cap of 10: the third page outruns the budget.
    const { ctx, state } = setup({ pageSize: 4 }, { timelineCap: 10 })
    const id = await save(ctx, 'https://fake.test/u/100')
    state.timelines['100'] = Array.from({ length: 40 }, (_, i) => i + 1)
    await save(ctx, 'https://fake.test/p/18')
    state.requests = []
    const update = startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ posts: 'until_existing' }) },
    )
    await ctx.queue.drain()
    const pages = () =>
      state.requests
        .filter((r) => r.kind === 'profile')
        .map((r) => r.pageCursor)
    expect(pages()).toEqual(['', '4', '8'])
    // The cap is soft: the last page is submitted whole, posts 11 and 12
    // included, since continuing starts after it.
    expect(savedPosts(ctx)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => i + 1),
      18,
    ])
    expect(updateDetail(ctx.db, update).profiles[0]!.posts).toMatchObject({
      total: 12,
      finished: 12,
      pending: 0,
      done: true,
      capped: true,
    })
    expect(updateRecord(ctx.db, update).done).toBe(true)

    // From the cursor, by the same rules: 17–20 holds the saved 18, then
    // one page more.
    continueTimeline(ctx, update, id)
    expect(updateRecord(ctx.db, update).done).toBe(false)
    expect(() => continueTimeline(ctx, update, id)).toThrow()
    await ctx.queue.drain()
    expect(pages().slice(3)).toEqual(['12', '16', '20'])
    // Nothing is lost between the two reads.
    expect(savedPosts(ctx)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
    expect(updateDetail(ctx.db, update).profiles[0]!.posts).toMatchObject({
      total: 24,
      finished: 24,
      pending: 0,
      done: true,
      capped: false,
    })
    expect(updateRecord(ctx.db, update).members).toMatchObject({
      total: 25,
      added: 23,
      updated: 2,
    })
    // The page after the last one read: older picks up there.
    expect(collectionUpdate(ctx, id).older).toBe(true)
  })

  test('latest reads the first page; older the page after the last one', async () => {
    const { ctx, state } = setup({
      timelines: { '100': [1, 2, 3, 4, 5, 6, 7] },
    })
    const id = await save(ctx, 'https://fake.test/u/100')
    expect(savedPosts(ctx)).toEqual([1, 2, 3])
    startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ count: 3 }), older: true },
    )
    await ctx.queue.drain()
    expect(savedPosts(ctx)).toEqual([1, 2, 3, 4, 5, 6])
    startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ count: 3 }), older: true },
    )
    await ctx.queue.drain()
    expect(savedPosts(ctx)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(collectionUpdate(ctx, id).older).toBe(false)
    expect(() =>
      startUpdate(
        ctx,
        { target: 'collection', id },
        { options: resolveOptions({ count: 3 }), older: true },
      ),
    ).toThrow('没有更多帖子了')
    // Without posts, only the profile is read again.
    state.timelines['100'] = [8, 9]
    const update = startUpdate(
      ctx,
      { target: 'collection', id },
      { options: resolveOptions({ posts: 'none' }) },
    )
    await ctx.queue.drain()
    expect(savedPosts(ctx)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(updateDetail(ctx.db, update).profiles[0]).not.toHaveProperty('posts')
  })

  test('a folder is expanded when it starts, each collection once', async () => {
    const { ctx, state } = setup({ timelines: { '100': [1, 2] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    await save(ctx, 'https://fake.test/p/3')
    const folder = createFolder(ctx.db, { name: '猫', filter: '' })
    expect(
      previewUpdate(ctx, { target: 'folder', id: folder.id }),
    ).toMatchObject({ posts: 3, profiles: 1, name: '猫' })
    const update = startUpdate(ctx, { target: 'folder', id: folder.id })
    // Saved after the start: not part of it.
    await save(ctx, 'https://fake.test/p/4')
    state.requests = []
    await ctx.queue.drain()
    const record = updateRecord(ctx.db, update)
    expect(record).toMatchObject({
      done: true,
      state: 'complete',
      update: { target: 'folder', name: '猫', posts: 3, profiles: 1 },
    })
    // Posts 1 and 2 are both items and on the profile's page: once each.
    expect(record.members!.total).toBe(4)
    const fetched = state.requests.map((r) => r.externalId)
    expect(fetched).not.toContain('4')
    expect(updateDetail(ctx.db, update).profiles).toMatchObject([
      { collectionId: profile, state: 'complete' },
    ])

    const many = startUpdate(ctx, {
      target: 'many',
      ids: [profile, profile],
    })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, many).update).toMatchObject({
      target: 'many',
      profiles: 1,
      posts: 0,
    })
  })

  test('feeds its items a few at a time', () => {
    const { ctx } = setup({}, { run: false })
    const ids = Array.from({ length: 8 }, (_, i) => {
      const job = captureURL(ctx, `https://fake.test/p/${i + 1}`)
      return job.collectionId
    })
    const update = startUpdate(ctx, { target: 'many', ids })
    const job = {
      id: 1,
      type: 'update',
      ref: update,
      attempt: 0,
      maxAttempts: 3,
      signal: new AbortController().signal,
    }
    // Their captures never run, so the window stays full.
    expect(() => runUpdate(ctx, job)).toThrow(SnoozeError)
    const row = ctx.db
      .select()
      .from(updates)
      .where(eq(updates.id, update))
      .get()!
    expect(row.position).toBe(5)
    expect(updateRecord(ctx.db, update)).toMatchObject({
      done: false,
      members: { pending: 5 },
      update: { queued: 3 },
    })
    stopUpdate(ctx, update)
    runUpdate(ctx, job)
    expect(updateRecord(ctx.db, update)).toMatchObject({
      done: true,
      stopped: true,
    })
  })

  test('failed items are retried within the same record', async () => {
    const { ctx, state } = setup()
    const ok = await save(ctx, 'https://fake.test/p/1')
    const bad = await save(ctx, 'https://fake.test/p/2')
    state.broken.add('2')
    const update = startUpdate(ctx, { target: 'many', ids: [ok, bad] })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'partial',
      retryable: 1,
      members: { complete: 1, failed: 1 },
    })
    expect(updateMembers(ctx.db, update, 'problem').items).toMatchObject([
      { collectionId: bad, state: 'failed' },
    ])
    const before = records(ctx).length
    state.broken.clear()
    expect(retryRecordFailed(ctx, update)).toBe(1)
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      retryable: 0,
      members: { total: 2, complete: 2, failed: 0 },
    })
    expect(records(ctx)).toHaveLength(before)
  })

  test('a paused update waits from where it was, while other work goes on', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3, 4, 5, 6] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const other = await save(ctx, 'https://fake.test/p/9')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 6 }) },
    )
    pauseUpdate(ctx, update)
    expect(updateRecord(ctx.db, update)).toMatchObject({
      done: false,
      paused: true,
    })
    // Another update of something else runs meanwhile.
    const second = startUpdate(ctx, { target: 'collection', id: other })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, second)).toMatchObject({ done: true })
    expect(updateRecord(ctx.db, update)).toMatchObject({
      done: false,
      paused: true,
    })
    expect(jobsOf(ctx, update)).toEqual([{ type: 'update', state: 'paused' }])

    resumeUpdate(ctx, update)
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      done: true,
    })
    expect(updateRecord(ctx.db, update).paused).toBeUndefined()
  })

  test("pausing mid-way holds the jobs the update's captures queued", async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3] } }, { run: false })
    const profile = captureURL(
      ctx,
      'https://fake.test/u/100',
      undefined,
      resolveOptions({ posts: 'none' }),
    ).collectionId
    ctx.queue.start()
    await ctx.queue.drain()
    await ctx.queue.stop()
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 3 }) },
    )
    pauseUpdate(ctx, update)
    expect(jobsOf(ctx, update)).toEqual([{ type: 'update', state: 'paused' }])
    // Stopping a paused update lets what it queued finish.
    stopUpdate(ctx, update)
    expect(jobsOf(ctx, update)).toEqual([
      { type: 'update', state: 'available' },
    ])
    expect(updateRecord(ctx.db, update).paused).toBeUndefined()
  })

  test('a finished update cannot be paused', async () => {
    const { ctx } = setup()
    const id = await save(ctx, 'https://fake.test/p/1')
    const update = startUpdate(ctx, { target: 'collection', id })
    await ctx.queue.drain()
    expect(() => pauseUpdate(ctx, update)).toThrow()
  })

  test('targets must be saved', () => {
    const { ctx } = setup()
    expect(() =>
      startUpdate(ctx, { target: 'collection', id: 'nope' }),
    ).toThrow('内容不存在或已删除')
    expect(() => startUpdate(ctx, { target: 'many', ids: [] })).toThrow(
      '不支持',
    )
    expect(() =>
      startUpdate(ctx, {
        target: 'folder',
        id: '01a20000-0000-7000-8000-000000000001',
      }),
    ).toThrow('内容不存在或已删除')
  })
})
