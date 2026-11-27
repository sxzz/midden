import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captures,
  collections,
  collectionStates,
  entities,
  entityVersions,
  jobs,
} from '#db/schema.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import {
  fetchPublicProfile,
  fetchPublicTimeline,
} from '#platforms/x/profile.ts'
import { CaptureStrategy } from '#platforms/x/strategy.ts'
import { testContext } from '#testing/context.ts'
import { captureHandlers } from './handlers.ts'
import { submit, type SubmitInput } from './submit.ts'
import {
  startUpdate,
  updateDetail,
  updateMembers,
  updateRecord,
} from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const HOUR = 60 * 60_000

/**
 * The X platform over a fake FxTwitter: `answer` gets each profile request's
 * path and query (`/VueUse?about_account=1`, `/id:1?about_account=1`), and
 * every timeline is empty.
 */
function setup(answer: (path: string) => unknown) {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const asked: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname.replace('/2/profile', ''))
    if (path.endsWith('/statuses'))
      return Response.json({ code: 200, results: [], cursor: {} })
    asked.push(path)
    const body = answer(`${path}${url.search}`) as { code: number }
    return Response.json(body, { status: body.code })
  }) as typeof fetch
  const strategy = new CaptureStrategy(
    undefined,
    (id, expand, signal) =>
      fetchPublicProfile(id, expand, signal, undefined, fetcher),
    undefined,
    undefined,
    () => clock,
  )
  strategy.timeline = (result, signal, _fetcher, cursor, size, since) =>
    fetchPublicTimeline(result, signal, fetcher, cursor, size, since)
  const c = testContext({
    platforms: [createXPlatform(strategy)],
    handlers: captureHandlers,
    now: () => clock,
  })
  ctx = c
  c.queue.start()
  return { ctx: c, asked, advance: (ms: number) => (clock += ms) }
}

const user = (id: string, screenName: string) => ({
  code: 200,
  user: {
    type: 'profile',
    id,
    name: screenName,
    screen_name: screenName,
    protected: false,
    description: '',
  },
})
const notFound = { code: 404, message: 'User not found' }
const suspended = (id: string) => ({
  code: 404,
  message: 'User is suspended',
  reason: 'suspended',
  id,
})

async function capture(c: CaptureContext, input: SubmitInput) {
  const job = submit(c, input)
  await c.queue.drain()
  return c.db.select().from(captures).where(eq(captures.id, job.id)).get()!
}

/** An account the library knows only from a list: an entity, no collection. */
function listed(c: CaptureContext, id: string, username: string, name = '') {
  c.db
    .insert(entities)
    .values({ id: `e${id}`, platform: 'x', kind: 'x.profile', externalId: id })
    .run()
  c.db
    .insert(entityVersions)
    .values({
      id: `v${id}`,
      entityId: `e${id}`,
      contentHash: `h${id}`,
      data: { username, name: name || username, avatar_url: '', metadata: {} },
    })
    .run()
}

describe('profile lookups', () => {
  test('not found by id waits for a second answer, as a missing account', async () => {
    const { ctx } = setup(() => notFound)
    const job = await capture(ctx, { url: 'https://x.com/i/user/42' })
    expect(job).toMatchObject({ state: 'failed', error: '账号已不存在' })
    expect(ctx.db.select().from(collectionStates).all()).toMatchObject([
      { state: 'deleted', confirmedAt: null },
    ])
    expect(
      ctx.db.select().from(jobs).where(eq(jobs.type, 'source-check')).all(),
    ).toHaveLength(1)
  })

  test("FxTwitter's suspended is X's own word: known at once, then no anomaly however the next capture fails", async () => {
    let answer: unknown = suspended('42')
    const { ctx, advance } = setup(() => answer)
    const first = await capture(ctx, { url: 'https://x.com/i/user/42' })
    expect(first.state).toBe('failed')
    expect(
      ctx.db.select({ state: collections.sourceState }).from(collections).get(),
    ).toEqual({ state: 'suspended' })
    expect(ctx.db.select().from(collectionStates).all()).toMatchObject([
      { state: 'suspended', confirmedAt: expect.any(Date) },
    ])
    expect(
      ctx.db.select().from(jobs).where(eq(jobs.type, 'source-check')).all(),
    ).toEqual([])

    advance(HOUR)
    const id = first.collectionId
    const update = startUpdate(ctx, { target: 'collection', id })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({
      members: { failed: 0, known: 1 },
      retryable: 0,
    })
    expect(updateMembers(ctx.db, update, 'problem').items).toEqual([])

    // An answer that says nothing of the account: the known state shows,
    // not the failure.
    answer = { code: 410, message: 'Gone' }
    advance(HOUR)
    const vague = startUpdate(ctx, { target: 'collection', id })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, vague)).toMatchObject({
      members: { failed: 0, known: 1 },
    })
    const detail = updateDetail(ctx.db, vague)
    expect(detail.reasons).toEqual([])
    expect(detail.profiles).toMatchObject([
      { state: 'failed', error: '', sourceState: 'suspended' },
    ])
    expect(updateMembers(ctx.db, vague, 'problem').items).toEqual([])
    expect(updateMembers(ctx.db, vague, '').items).toMatchObject([
      { state: 'failed', sourceState: 'suspended', retryable: false },
    ])
  })
})

describe('member names', () => {
  test('a profile member keyed by id is named by its account and linked to where it is saved', async () => {
    const { ctx } = setup((path) =>
      path.startsWith('/id:7') ? user('7', 'Alice') : notFound,
    )
    // Saved by its handle; the library knows its id from a list.
    listed(ctx, '1546010181070249984', 'Raffel12310', 'Harel')
    const saved = await capture(ctx, { url: 'https://x.com/i/user/7' })
    const missing = await capture(ctx, {
      url: 'https://x.com/i/user/1546010181070249984',
    })
    expect(missing.state).toBe('failed')
    const update = startUpdate(ctx, {
      target: 'many',
      ids: [saved.collectionId, missing.collectionId],
    })
    await ctx.queue.drain()
    const members = updateMembers(ctx.db, update, '').items
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'profile',
          handle: 'Alice',
          name: 'Alice',
          libraryId: saved.collectionId,
        }),
        expect.objectContaining({
          kind: 'profile',
          url: 'https://x.com/i/user/1546010181070249984',
          handle: 'Raffel12310',
          name: 'Harel',
        }),
      ]),
    )
    // Nothing of it is saved: no page in the library to open.
    expect(
      members.find((m) => m.collectionId === missing.collectionId)?.libraryId,
    ).toBeUndefined()
  })
})
