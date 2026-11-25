import { asc, eq } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import {
  captures,
  collections,
  collectionStates,
  jobs,
  submissions,
} from '#db/schema.ts'
import { RANK } from '#jobs/queue.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  postGraph,
  type FakeFetch,
} from '#testing/fake-platform.ts'
import { entity, graph } from '#testing/library.ts'
import { captureHandlers } from './handlers.ts'
import { CONFIRM_GAP_MS, RECHECK_KEY, RECHECK_MS } from './source-state.ts'
import { submit, type SubmitInput } from './submit.ts'
import {
  listRecords,
  startUpdate,
  updateMembers,
  updateRecord,
} from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = 'https://fake.test/p/1'
/** A profile: captured again whenever asked, as an update asks. */
const profile = 'https://fake.test/u/7'
const HOUR = 60 * 60_000

/** What the platform answers: the post, or that it is gone. */
type Answer = 'ok' | 'gone' | 'explicit' | 'suspended'

function setup() {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const state = { answer: 'ok' as Answer }
  const fetch: FakeFetch = (req) => {
    if (state.answer === 'ok')
      return req.externalId === '7'
        ? { text: 'bio', graph: graph([entity('root', 'fake.profile', '7')]) }
        : { text: 'hello', graph: postGraph('1', { text: 'hello' }) }
    throw new FakeFailure(
      status.FAILED_PRECONDITION,
      state.answer === 'suspended' ? '账号已被封禁' : '帖子不存在或已删除',
      {
        'source-state': state.answer === 'suspended' ? 'suspended' : 'deleted',
        ...(state.answer === 'explicit'
          ? { 'source-state-explicit': '1' }
          : {}),
      },
    )
  }
  const c = testContext({
    platforms: [fakePlatform({ current: fetch })],
    handlers: captureHandlers,
    now: () => clock,
  })
  ctx = c
  c.queue.start()
  return {
    ctx: c,
    state,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  }
}

async function capture(c: CaptureContext, input: SubmitInput) {
  const job = submit(c, input)
  await c.queue.drain()
  return c.db.select().from(captures).where(eq(captures.id, job.id)).get()!
}

const marked = (c: CaptureContext) =>
  c.db
    .select({ state: collections.sourceState, at: collections.sourceStateAt })
    .from(collections)
    .get()!
const states = (c: CaptureContext) =>
  c.db
    .select()
    .from(collectionStates)
    .orderBy(asc(collectionStates.since))
    .all()

test('one answer marks nothing; an agreeing one an hour later does', async () => {
  const { ctx, state, advance, now } = setup()
  const saved = await capture(ctx, { url: post })
  const id = saved.collectionId
  state.answer = 'gone'
  const first = now()
  await capture(ctx, { refreshId: id })
  expect(marked(ctx).state).toBeNull()
  // Asked again right away, the same answer is not a second one yet.
  advance(5 * 60_000)
  await capture(ctx, { refreshId: id })
  expect(marked(ctx).state).toBeNull()
  expect(states(ctx)).toMatchObject([
    { state: 'deleted', confirmedAt: null, endedAt: null },
  ])
  // The re-check, an hour after the first answer, agrees.
  advance(RECHECK_MS)
  await ctx.queue.drain()
  const check = ctx.db
    .select()
    .from(submissions)
    .where(eq(submissions.idemKey, `${RECHECK_KEY}${states(ctx)[0]!.id}`))
    .get()
  expect(check).toBeDefined()
  expect(marked(ctx)).toEqual({ state: 'deleted', at: new Date(first) })
  expect(states(ctx)).toMatchObject([
    {
      state: 'deleted',
      since: new Date(first),
      confirmedAt: new Date(now()),
      endedAt: null,
    },
  ])
  // The archived content stays.
  const kept = ctx.db.select().from(collections).get()!
  expect(kept.currentRevision).toBe(saved.revisionId)
})

test('the re-check finding the content clears the first answer', async () => {
  const { ctx, state, advance } = setup()
  const { collectionId: id } = await capture(ctx, { url: post })
  state.answer = 'gone'
  await capture(ctx, { refreshId: id })
  state.answer = 'ok'
  advance(RECHECK_MS)
  await ctx.queue.drain()
  expect(marked(ctx).state).toBeNull()
  expect(states(ctx)).toEqual([])
})

test("the account's own explicit answer marks at once", async () => {
  const { ctx, state } = setup()
  const { collectionId: id } = await capture(ctx, { url: post })
  state.answer = 'explicit'
  await capture(ctx, { refreshId: id })
  expect(marked(ctx).state).toBe('deleted')
  expect(
    ctx.db.select().from(jobs).where(eq(jobs.type, 'source-check')).all(),
  ).toEqual([])
})

test('a normal capture ends the state, kept in the history', async () => {
  const { ctx, state, advance, now } = setup()
  const { collectionId: id } = await capture(ctx, { url: post })
  state.answer = 'explicit'
  await capture(ctx, { refreshId: id })
  const since = now()
  advance(HOUR)
  // Seen again: nothing new.
  await capture(ctx, { refreshId: id })
  expect(states(ctx)).toHaveLength(1)
  expect(states(ctx)[0]!.seenAt).toEqual(new Date(now()))
  advance(HOUR)
  state.answer = 'ok'
  await capture(ctx, { refreshId: id })
  expect(marked(ctx)).toEqual({ state: null, at: null })
  expect(states(ctx)).toMatchObject([
    { state: 'deleted', since: new Date(since), endedAt: new Date(now()) },
  ])
})

test('another state, once confirmed, ends the one before', async () => {
  const { ctx, state, advance } = setup()
  const { collectionId: id } = await capture(ctx, { url: post })
  state.answer = 'explicit'
  await capture(ctx, { refreshId: id })
  advance(HOUR)
  state.answer = 'suspended'
  await capture(ctx, { refreshId: id })
  // Not confirmed yet: still deleted.
  expect(marked(ctx).state).toBe('deleted')
  advance(CONFIRM_GAP_MS)
  await capture(ctx, { refreshId: id })
  expect(marked(ctx).state).toBe('suspended')
  expect(states(ctx).map((row) => [row.state, !!row.endedAt])).toEqual([
    ['deleted', true],
    ['suspended', false],
  ])
})

test('seeing a known state again is no anomaly, nor anything to retry', async () => {
  const { ctx, state, advance } = setup()
  const { collectionId: id } = await capture(ctx, { url: profile })
  // Before it is known, a gone post is a failure like any other.
  state.answer = 'gone'
  const first = startUpdate(ctx, { target: 'collection', id })
  await ctx.queue.drain()
  expect(updateRecord(ctx.db, first)).toMatchObject({
    state: 'failed',
    members: { failed: 1, known: 0 },
  })
  // Its re-check is the worker's own background work, not the update's.
  expect(
    ctx.db
      .select({ updateId: jobs.updateId, priority: jobs.priority })
      .from(jobs)
      .where(eq(jobs.type, 'source-check'))
      .all(),
  ).toEqual([{ updateId: null, priority: RANK.maintenance }])
  state.answer = 'explicit'
  advance(HOUR)
  const again = startUpdate(ctx, { target: 'collection', id })
  await ctx.queue.drain()
  expect(updateRecord(ctx.db, again)).toMatchObject({
    state: 'complete',
    members: { failed: 0, known: 1, updated: 1 },
    retryable: 0,
  })
  expect(updateMembers(ctx.db, again, 'problem').items).toEqual([])
  expect(updateMembers(ctx.db, again, 'updated').items).toMatchObject([
    {
      collectionId: id,
      state: 'failed',
      sourceState: 'deleted',
      retryable: false,
    },
  ])
  // A capture of its link on its own says so too.
  advance(HOUR)
  const single = await capture(ctx, { refreshId: id, key: 'again' })
  expect(single.state).toBe('failed')
  expect(
    listRecords(ctx.db).items.find(
      (r) => 'jobId' in r && r.jobId === single.id,
    ),
  ).toMatchObject({ sourceState: 'deleted' })
})
