import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount, type AccountsContext } from '#accounts/accounts.ts'
import { captures, jobs, rateLimits, relationFetches } from '#db/schema.ts'
import { queueRoutes } from '#http/queue-routes.ts'
import { activeRateLimits, clearRateLimit } from '#jobs/rate-limits.ts'
import { status } from '#platforms/rpc.ts'
import { upstream } from '#platforms/upstream.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  fakeProfile,
  postGraph,
} from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { DEFAULT_OPTIONS } from './options.ts'
import { captureWaits } from './records.ts'
import { submit } from './submit.ts'
import type { RelationsRequest } from '#platforms/platform.ts'
import type { FetchRequest } from '#platforms/protocol.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

type Answer = (url: URL) => Response | undefined

/**
 * The fake platform asking real-looking APIs: a public post from FxTwitter,
 * a protected one (`/p/9…`) from X's GraphQL with the account, which the
 * capture lends only once the post turns out to need it. `answer` decides
 * what each request gets; by default every request succeeds.
 */
function setup() {
  const requests: string[] = []
  const world: { answer: Answer } = { answer: () => undefined }
  let clock = Date.parse('2026-11-26T08:00:00Z')
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(`${url.hostname}${url.pathname}`)
    return world.answer(url) ?? Response.json({ ok: true })
  }) as typeof fetch
  const ask = async (url: string) => {
    const response = await upstream(fetcher, url)
    if (response.status === 429)
      throw new FakeFailure(status.UNAVAILABLE, '来源平台限流', {
        'rate-limited': '1',
      })
    const body = (await response.json()) as {
      errors?: { code: number }[]
    }
    // X's error 88 comes in a successful response.
    if (body.errors?.[0]?.code === 88)
      throw new FakeFailure(status.UNAVAILABLE, '来源平台限流', {
        'rate-limited': '1',
      })
    if (!response.ok)
      throw new FakeFailure(status.UNAVAILABLE, `HTTP ${response.status}`)
  }
  const fetchPost = async (req: FetchRequest) => {
    const id = req.externalId
    if (req.kind === 'profile') {
      await ask(`https://api.fxtwitter.com/2/profile/${id}`)
      // Its lists are read with an account: it does not say it is public.
      return {
        ...fakeProfile(id, { metadata: { following: 1, followers: 0 } }),
        providerId: req.providerId,
      }
    }
    if (id.startsWith('9')) {
      if (!req.credential) {
        const error = new FakeFailure(status.FAILED_PRECONDITION, '需要账号')
        error.metadata.set('credential-required', '1')
        throw error
      }
      await ask(`https://x.com/i/api/graphql/abc/TweetResultByRestId?id=${id}`)
    } else await ask(`https://api.fxtwitter.com/2/status/${id}`)
    return { text: `post ${id}`, graph: postGraph(id, { text: `post ${id}` }) }
  }
  const lists = async (req: RelationsRequest) => {
    await ask(
      `https://x.com/i/api/graphql/def/${req.list === 'following' ? 'Following' : 'Followers'}`,
    )
    return { accounts: [fakeProfile('1')], nextCursor: '' }
  }
  ctx = testContext({
    platforms: [fakePlatform({ current: fetchPost }, { current: lists })],
    handlers: captureHandlers,
    now: () => clock,
  })
  ctx.queue.start()
  return {
    ctx,
    requests,
    world,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

async function account(c: AccountsContext, name: string) {
  return (await addAccount(c, 'fake', { credential: Buffer.from(name) })).id
}

async function capture(c: AccountsContext, id: string, connectionId?: string) {
  const job = submit(c, { url: `https://fake.test/p/${id}`, connectionId })
  await c.queue.drain()
  return job.id
}

const stateOf = (c: AccountsContext, id: string) =>
  c.db.select().from(captures).where(eq(captures.id, id)).get()!.state
const jobOf = (c: AccountsContext, ref: string) =>
  c.db.select().from(jobs).where(eq(jobs.ref, ref)).get()
const graphql = (requests: string[]) =>
  requests.filter((r) => r.startsWith('x.com')).length

describe('rate limits', () => {
  test('a 429 pauses only its scope until the reset, and uses no attempt', async () => {
    const { ctx, requests, world, advance, now } = setup()
    const a = await account(ctx, 'a')
    const b = await account(ctx, 'b')
    const reset = Math.floor(now() / 1000) + 600
    world.answer = (url) =>
      url.hostname === 'x.com'
        ? new Response('Rate limit exceeded', {
            status: 429,
            headers: {
              'x-rate-limit-limit': '150',
              'x-rate-limit-remaining': '0',
              'x-rate-limit-reset': String(reset),
            },
          })
        : undefined
    const limited = await capture(ctx, '91', a)
    expect(stateOf(ctx, limited)).toBe('queued')
    const scope = `x:session:${a}:TweetResultByRestId`
    expect(jobOf(ctx, limited)).toMatchObject({
      attempt: 0,
      rateScope: scope,
      runAt: new Date(reset * 1000),
      state: 'available',
    })
    expect(ctx.db.select().from(rateLimits).all()).toEqual([
      {
        scope,
        until: new Date(reset * 1000),
        reason: 'HTTP 429',
        hits: 1,
        since: new Date(now()),
      },
    ])
    expect(captureWaits(ctx.db, [limited], now()).get(limited)).toBe(
      'rate_limit',
    )
    expect(graphql(requests)).toBe(1)

    // Another protected post with the same account waits without asking.
    const second = await capture(ctx, '92', a)
    expect(jobOf(ctx, second)).toMatchObject({ attempt: 0, rateScope: scope })
    expect(graphql(requests)).toBe(1)
    // The same account's public post asks only FxTwitter: it goes on.
    expect(stateOf(ctx, await capture(ctx, '3', a))).toBe('complete')
    // So does a public post without an account.
    expect(stateOf(ctx, await capture(ctx, '4'))).toBe('complete')
    // Another account is limited on its own.
    world.answer = () => undefined
    expect(stateOf(ctx, await capture(ctx, '93', b))).toBe('complete')
    expect(activeRateLimits(ctx.db, now())).toMatchObject([
      { scope, waiting: 2, hits: 1 },
    ])

    // Not before the reset...
    advance(500_000)
    await ctx.queue.drain()
    expect(stateOf(ctx, limited)).toBe('queued')
    // ...and both once it passed, one after the other with the account.
    advance(101_000)
    await ctx.queue.drain()
    advance(1000)
    await ctx.queue.drain()
    expect(stateOf(ctx, limited)).toBe('complete')
    expect(stateOf(ctx, second)).toBe('complete')
    expect(activeRateLimits(ctx.db, now())).toEqual([])
  })

  test('the public FxTwitter instance is a scope of its own', async () => {
    const { ctx, requests, world, advance, now } = setup()
    const a = await account(ctx, 'a')
    world.answer = (url) =>
      url.hostname === 'api.fxtwitter.com'
        ? new Response('Too Many Requests', {
            status: 429,
            headers: { 'retry-after': '120' },
          })
        : undefined
    const limited = await capture(ctx, '1')
    expect(jobOf(ctx, limited)).toMatchObject({
      attempt: 0,
      rateScope: 'fxtwitter:public',
      runAt: new Date(now() + 120_000),
    })
    // Whatever account a capture uses, FxTwitter waits...
    const viaAccount = await capture(ctx, '2', a)
    expect(jobOf(ctx, viaAccount)?.rateScope).toBe('fxtwitter:public')
    expect(requests.filter((r) => r.startsWith('api.fxtwitter'))).toHaveLength(
      1,
    )
    // ...and X with the account does not.
    expect(stateOf(ctx, await capture(ctx, '91', a))).toBe('complete')

    world.answer = () => undefined
    advance(120_000)
    await ctx.queue.drain()
    expect(stateOf(ctx, limited)).toBe('complete')
    expect(stateOf(ctx, viaAccount)).toBe('complete')
  })

  test('without a reset the limit lasts the fallback; a limit in a body counts too', async () => {
    const { ctx, world, now } = setup()
    const a = await account(ctx, 'a')
    world.answer = (url) =>
      url.hostname === 'x.com'
        ? Response.json(
            { errors: [{ code: 88, message: 'Rate limit exceeded' }] },
            {
              headers: {
                'x-rate-limit-reset': String(Math.floor(now() / 1000) + 300),
              },
            },
          )
        : new Response('', { status: 429 })
    const body = await capture(ctx, '91', a)
    expect(jobOf(ctx, body)).toMatchObject({
      attempt: 0,
      rateScope: `x:session:${a}:TweetResultByRestId`,
      runAt: new Date(now() + 300_000),
    })
    expect(
      ctx.db
        .select({ reason: rateLimits.reason })
        .from(rateLimits)
        .where(eq(rateLimits.scope, `x:session:${a}:TweetResultByRestId`))
        .get()?.reason,
    ).toBe('来源平台限流')
    const bare = await capture(ctx, '1')
    expect(jobOf(ctx, bare)).toMatchObject({
      rateScope: 'fxtwitter:public',
      runAt: new Date(now() + 5 * 60_000),
    })
  })

  test('clearing a limit runs its jobs at once', async () => {
    const { ctx, world, now } = setup()
    world.answer = (url) =>
      url.hostname === 'api.fxtwitter.com'
        ? new Response('', { status: 429 })
        : undefined
    const limited = await capture(ctx, '1')
    expect(stateOf(ctx, limited)).toBe('queued')
    world.answer = () => undefined
    expect(
      ctx.db.transaction((tx) => clearRateLimit(tx, 'fxtwitter:public', now())),
    ).toBe(true)
    expect(jobOf(ctx, limited)).toMatchObject({ rateScope: null })
    await ctx.queue.drain()
    expect(stateOf(ctx, limited)).toBe('complete')
  })

  test('the admin page lists limits and ends one early', async () => {
    const { ctx, world, now } = setup()
    const a = await account(ctx, 'a')
    world.answer = (url) =>
      url.hostname === 'x.com'
        ? new Response('', { status: 429, headers: { 'retry-after': '600' } })
        : undefined
    const limited = await capture(ctx, '91', a)
    const routes = queueRoutes(ctx.db, { worker: () => undefined }, now)
    const view = async (response: Response | Promise<Response>) =>
      ((await (await response).json()) as { rate_limits: unknown[] })
        .rate_limits
    expect(await view(routes.request('/'))).toEqual([
      {
        scope: `x:session:${a}:TweetResultByRestId`,
        platform: 'x',
        account: '@fake',
        endpoint: 'TweetResultByRestId',
        until: new Date(now() + 600_000).toISOString(),
        since: new Date(now()).toISOString(),
        hits: 1,
        reason: 'HTTP 429',
        waiting: 1,
      },
    ])
    world.answer = () => undefined
    const cleared = routes.request('/rate-limits/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: `x:session:${a}:TweetResultByRestId` }),
    })
    expect(await view(cleared)).toEqual([])
    await ctx.queue.drain()
    expect(stateOf(ctx, limited)).toBe('complete')
  })

  test("a list's pages wait for the account's limit too", async () => {
    const { ctx, world, advance, now } = setup()
    const a = await account(ctx, 'a')
    const reset = Math.floor(now() / 1000) + 900
    world.answer = (url) =>
      url.pathname.endsWith('/Following')
        ? new Response('', {
            status: 429,
            headers: { 'x-rate-limit-reset': String(reset) },
          })
        : undefined
    submit(ctx, {
      url: 'https://fake.test/u/100',
      connectionId: a,
      options: { ...DEFAULT_OPTIONS, relations: true, posts: 'none' },
    })
    await ctx.queue.drain()
    const fetch = ctx.db
      .select()
      .from(relationFetches)
      .where(eq(relationFetches.list, 'following'))
      .get()!
    expect(fetch.state).toBe('running')
    // X limits each endpoint: the followers list goes on, once the account
    // is free.
    advance(1000)
    await ctx.queue.drain()
    expect(
      ctx.db
        .select({ state: relationFetches.state })
        .from(relationFetches)
        .where(eq(relationFetches.list, 'followers'))
        .get()?.state,
    ).toBe('complete')
    expect(jobOf(ctx, fetch.id)).toMatchObject({
      attempt: 0,
      rateScope: `x:session:${a}:Following`,
      runAt: new Date(reset * 1000),
    })
    world.answer = () => undefined
    advance(899_000)
    await ctx.queue.drain()
    expect(
      ctx.db
        .select({ state: relationFetches.state })
        .from(relationFetches)
        .where(eq(relationFetches.id, fetch.id))
        .get()?.state,
    ).toBe('complete')
  })
})
