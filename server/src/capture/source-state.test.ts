import { asc, eq } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import {
  captures,
  collections,
  collectionStates,
  jobs,
  submissions,
} from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  postGraph,
  type FakeFetch,
} from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { CONFIRM_GAP_MS, RECHECK_KEY, RECHECK_MS } from './source-state.ts'
import { submit, type SubmitInput } from './submit.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = 'https://fake.test/p/1'
const HOUR = 60 * 60_000

/** What the platform answers: the post, or that it is gone. */
type Answer = 'ok' | 'gone' | 'explicit' | 'suspended'

function setup() {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const state = { answer: 'ok' as Answer }
  const fetch: FakeFetch = () => {
    if (state.answer === 'ok')
      return { text: 'hello', graph: postGraph('1', { text: 'hello' }) }
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
