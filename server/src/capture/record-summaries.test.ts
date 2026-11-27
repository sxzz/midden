import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { recordSummaries, updates } from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import { FakeFailure, fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import {
  forgetRecords,
  keepFinishedRecords,
  RUNNING_TTL,
} from './record-cache.ts'
import { dropAllSummaries, SUMMARY_MAX_AGE } from './record-summaries.ts'
import { captureURL } from './records.ts'
import { retryRecordFailed } from './retries.ts'
import { refreshSummaries } from './summary-sweep.ts'
import {
  listRecords,
  startUpdate,
  updateDetail,
  updateRecord,
} from './updates.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  keepFinishedRecords(false)
  vi.useRealTimers()
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(options: { run?: boolean; now?: () => number } = {}) {
  const broken = new Set<string>()
  const context = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            if (broken.has(req.externalId))
              throw new FakeFailure(status.PERMISSION_DENIED, 'no access')
            return { text: 'post', graph: postGraph(req.externalId, {}) }
          },
        },
        { current: () => ({ accounts: [], nextCursor: '' }) },
      ),
    ],
    handlers: captureHandlers,
    now: options.now,
  })
  ctx = context
  if (options.run !== false) context.queue.start()
  return { ctx: context, broken }
}

async function save(c: AccountsContext, id: number) {
  const job = captureURL(
    c,
    `https://fake.test/p/${id}`,
    undefined,
    resolveOptions({ count: 3 }),
  )
  await c.queue.drain()
  return job.collectionId
}

/** How many times the progress of updates was read while `run` ran. */
function countingMembers<T>(c: AccountsContext, run: () => T) {
  const client = c.db.$client
  const prepare = client.prepare.bind(client)
  let counted = 0
  client.prepare = ((text: string) => {
    const statement = prepare(text)
    if (!text.includes('SELECT * FROM update_progress WHERE')) return statement
    const all = statement.all.bind(statement)
    statement.all = ((...args: never[]) => {
      counted++
      return all(...args)
    }) as typeof statement.all
    return statement
  }) as typeof client.prepare
  const restore = () => {
    client.prepare = prepare
  }
  try {
    const result = run()
    // Promises are counted until they settle.
    if (result instanceof Promise) result.finally(restore).catch(() => {})
    else restore()
    return { result, counted: () => counted }
  } catch (error) {
    restore()
    throw error
  }
}

/** A running update: nothing runs it, so it stays in progress. */
function runningUpdate() {
  const { ctx } = setup({ run: false })
  const first = captureURL(ctx, 'https://fake.test/p/1')
  const second = captureURL(ctx, 'https://fake.test/p/2')
  return {
    ctx,
    id: startUpdate(ctx, {
      target: 'many',
      ids: [first.collectionId, second.collectionId],
    }),
  }
}

const poll = (c: AccountsContext) => listRecords(c.db).items

describe('records in progress are kept for a short while', () => {
  test('polls within the TTL do not count the members again, after it they do', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ctx, id } = runningUpdate()
    keepFinishedRecords()
    const first = countingMembers(ctx, () => poll(ctx))
    expect(first.counted()).toBe(1)
    expect(first.result[0]).toMatchObject({ id, done: false })
    vi.advanceTimersByTime(RUNNING_TTL - 100)
    const second = countingMembers(ctx, () => poll(ctx))
    expect(second.counted()).toBe(0)
    expect(second.result).toEqual(first.result)
    vi.advanceTimersByTime(200)
    expect(countingMembers(ctx, () => poll(ctx)).counted()).toBe(1)
  })

  test('its position moving is not a change, its state is', () => {
    const { ctx, id } = runningUpdate()
    keepFinishedRecords()
    poll(ctx)
    ctx.db.update(updates).set({ position: 1 }).where(eq(updates.id, id)).run()
    expect(countingMembers(ctx, () => poll(ctx)).counted()).toBe(0)
    ctx.db
      .update(updates)
      .set({ state: 'stopped' })
      .where(eq(updates.id, id))
      .run()
    const stopped = countingMembers(ctx, () => poll(ctx))
    expect(stopped.counted()).toBe(1)
    expect(stopped.result[0]).toMatchObject({ id, done: true })
  })

  test('a write announced to the threads makes the next poll count', () => {
    const { ctx } = runningUpdate()
    keepFinishedRecords()
    poll(ctx)
    expect(countingMembers(ctx, () => poll(ctx)).counted()).toBe(0)
    forgetRecords()
    expect(countingMembers(ctx, () => poll(ctx)).counted()).toBe(1)
  })

  test('requests that arrive together count a record once', async () => {
    const { ctx } = runningUpdate()
    keepFinishedRecords()
    const polls = countingMembers(ctx, () =>
      Promise.all([
        Promise.resolve().then(() => poll(ctx)),
        Promise.resolve().then(() => poll(ctx)),
        Promise.resolve().then(() => poll(ctx)),
      ]),
    )
    await polls.result
    expect(polls.counted()).toBe(1)
  })

  test('the detail takes the counts the list kept', () => {
    const { ctx, id } = runningUpdate()
    keepFinishedRecords()
    poll(ctx)
    const detail = countingMembers(ctx, () => updateDetail(ctx.db, id))
    expect(detail.counted()).toBe(0)
    expect(detail.result).toMatchObject({ id, done: false })
  })
})

describe('finished records are written down by the worker', () => {
  async function finished(now?: () => number) {
    const { ctx, broken } = setup({ now })
    const ok = await save(ctx, 1)
    const bad = await save(ctx, 2)
    broken.add('2')
    const update = startUpdate(ctx, { target: 'many', ids: [ok, bad] })
    await ctx.queue.drain()
    return { ctx, broken, update }
  }

  test('reads of a finished update count nothing once it is written down', async () => {
    const { ctx, update } = await finished()
    expect(countingMembers(ctx, () => poll(ctx)).counted()).toBeGreaterThan(0)
    expect(refreshSummaries(ctx)).toBeGreaterThanOrEqual(1)
    expect(
      ctx.db
        .select()
        .from(recordSummaries)
        .all()
        .map((row) => row.id),
    ).toContain(update)
    const read = countingMembers(ctx, () => poll(ctx))
    expect(read.counted()).toBe(0)
    expect(read.result[0]).toMatchObject({
      id: update,
      state: 'partial',
      retryable: 1,
      members: { complete: 1, failed: 1 },
    })
    expect(read.result[0]!.createdAt).toBeInstanceOf(Date)
    // Nothing changed: the next sweep writes nothing.
    expect(refreshSummaries(ctx)).toBe(0)
  })

  test('a retry drops it, and the record is counted again', async () => {
    const { ctx, broken, update } = await finished()
    refreshSummaries(ctx)
    broken.clear()
    expect(retryRecordFailed(ctx, update)).toBe(1)
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      retryable: 0,
    })
    // And written down again, as it stands now.
    expect(refreshSummaries(ctx)).toBeGreaterThanOrEqual(1)
    expect(
      countingMembers(ctx, () => updateRecord(ctx.db, update)).counted(),
    ).toBe(0)
  })

  test('a change to its own row is seen at once; dropping them all', async () => {
    const { ctx, update } = await finished()
    refreshSummaries(ctx)
    ctx.db
      .update(updates)
      .set({ error: 'x' })
      .where(eq(updates.id, update))
      .run()
    expect(updateRecord(ctx.db, update)).toMatchObject({ error: 'x' })
    refreshSummaries(ctx)
    dropAllSummaries(ctx.db)
    expect(ctx.db.select().from(recordSummaries).all()).toEqual([])
  })

  test('one that is not done is not written down', () => {
    const { ctx } = runningUpdate()
    expect(refreshSummaries(ctx)).toBe(0)
    expect(ctx.db.select().from(recordSummaries).all()).toEqual([])
  })

  test('a summary is counted again once it is old', async () => {
    let now = Date.now()
    const { ctx, update } = await finished(() => now)
    expect(refreshSummaries(ctx)).toBeGreaterThanOrEqual(1)
    expect(refreshSummaries(ctx)).toBe(0)
    now += SUMMARY_MAX_AGE + 1000
    expect(refreshSummaries(ctx)).toBeGreaterThanOrEqual(1)
    expect(
      ctx.db
        .select()
        .from(recordSummaries)
        .where(eq(recordSummaries.id, update))
        .get()
        ?.computedAt.getTime(),
    ).toBe(now)
  })
})
