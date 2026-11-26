import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { captures } from '#db/schema.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import { fetchPublicProfile } from '#platforms/x/profile.ts'
import { CaptureStrategy } from '#platforms/x/strategy.ts'
import { testContext } from '#testing/context.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import { captureHandlers } from './handlers.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** The X platform with FxTwitter's profile endpoint answered by `fetcher`. */
function setup(fetcher: typeof fetch) {
  const { logger, entries } = recordingLogger()
  const strategy = new CaptureStrategy(undefined, (id, expand, signal) =>
    fetchPublicProfile(id, expand, signal, undefined, fetcher),
  )
  ctx = testContext({
    platforms: [createXPlatform(strategy)],
    handlers: captureHandlers,
    logger,
  })
  ctx.queue.start()
  return { ctx, entries }
}

const url = 'https://x.com/xiaomouzovo'

describe('capture failure logs', () => {
  test('a permanent upstream failure is logged with the request and the job', async () => {
    const { ctx, entries } = setup(async () =>
      Response.json({ code: 404, message: 'User not found' }, { status: 404 }),
    )
    const job = submit(ctx, { url })
    await ctx.queue.drain()
    const capture = ctx.db
      .select()
      .from(captures)
      .where(eq(captures.id, job.id))
      .get()!
    expect(capture.state).toBe('failed')

    const request = entries.find((e) => e.msg === 'upstream request failed')
    expect(request).toMatchObject({
      level: levels.error,
      captureId: capture.id,
      jobType: 'capture',
      attempt: 1,
      maxAttempts: 3,
      platform: 'x',
      providerId: 'fxtwitter',
      target: { kind: 'profile', url },
      errorCode: 'FAILED_PRECONDITION',
      errorMessage: '账号不存在或已改名',
      retryable: false,
      final: true,
      upstream: {
        provider: 'fxtwitter',
        operation: 'profile',
        status: 404,
        url: 'https://api.fxtwitter.com/2/profile/xiaomouzovo?about_account=1',
        body: '{"code":404,"message":"User not found"}',
      },
    })
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.error,
        msg: 'job failed',
        jobType: 'capture',
        ref: capture.id,
        state: 'failed',
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.error,
        msg: 'capture failed',
        captureId: capture.id,
        errorCode: 'FAILED_PRECONDITION',
        target: expect.objectContaining({ url }),
      }),
    )
  })

  test('a failure that will be retried is a warning', async () => {
    const { ctx, entries } = setup(
      async () =>
        new Response('unavailable', {
          status: 503,
          headers: { 'retry-after': '60' },
        }),
    )
    submit(ctx, { url })
    await ctx.queue.drain()
    expect(
      entries.find((e) => e.msg === 'upstream request failed'),
    ).toMatchObject({
      level: levels.warn,
      attempt: 1,
      errorCode: 'UNAVAILABLE',
      retryable: true,
      final: false,
      upstream: { status: 503, headers: { 'retry-after': '60' } },
    })
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.warn,
        msg: 'job will retry',
        retryInMs: 60_000,
      }),
    )
  })

  test('a rate limit is a warning, and the job waits for its end', async () => {
    const { ctx, entries } = setup(
      async () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '60', 'x-rate-limit-remaining': '0' },
        }),
    )
    submit(ctx, { url })
    await ctx.queue.drain()
    expect(
      entries.find((e) => e.msg === 'upstream request failed'),
    ).toMatchObject({
      level: levels.warn,
      attempt: 1,
      errorCode: 'UNAVAILABLE',
      retryable: true,
      final: false,
      upstream: {
        status: 429,
        headers: { 'retry-after': '60', 'x-rate-limit-remaining': '0' },
        body: 'rate limited',
      },
    })
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.info,
        msg: 'job waits for a rate limit',
        scope: 'fxtwitter:public',
      }),
    )
    expect(entries.some((e) => e.msg === 'job will retry')).toBe(false)
  })
})
