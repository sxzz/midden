import { describe, expect, test } from 'vitest'
import { levels, recordingLogger } from '#testing/logs.ts'
import {
  describe as describeURL,
  redactText,
  redactURL,
  traceUpstream,
  upstream,
  type Classification,
} from './upstream.ts'

const final: Classification = {
  code: 'FAILED_PRECONDITION',
  message: '账号不存在或已改名',
  retryable: false,
  final: true,
}

describe('upstream request logs', () => {
  test('a failed response is logged with status, redacted URL, headers and body', async () => {
    const { logger, entries } = recordingLogger()
    const fetcher: typeof fetch = async () =>
      Response.json(
        { code: 404, message: 'User not found', auth_token: 'leaked-secret' },
        {
          status: 404,
          headers: {
            'retry-after': '30',
            'x-rate-limit-remaining': '0',
            'set-cookie': 'sessionid=cookie-secret',
          },
        },
      )
    await expect(
      traceUpstream({ logger, classify: () => final }, async () => {
        const response = await upstream(
          fetcher,
          'https://user:pass@api.fxtwitter.com/2/profile/someone?about_account=1&auth_token=query-secret&ct0=csrf-secret#frag',
          { headers: { cookie: 'auth_token=header-secret' } },
        )
        // The platform code still reads the whole body.
        expect(await response.json()).toMatchObject({ code: 404 })
        throw new Error('not found')
      }),
    ).rejects.toThrow('not found')

    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry).toMatchObject({
      level: levels.error,
      msg: 'upstream request failed',
      errorCode: 'FAILED_PRECONDITION',
      errorMessage: '账号不存在或已改名',
      retryable: false,
      final: true,
      upstream: {
        provider: 'fxtwitter',
        operation: 'profile',
        method: 'GET',
        status: 404,
        url: 'https://api.fxtwitter.com/2/profile/someone?about_account=1&auth_token=redacted&ct0=redacted',
        headers: {
          'retry-after': '30',
          'x-rate-limit-remaining': '0',
          'content-type': 'application/json',
        },
      },
    })
    expect(entry!.upstream.body).toContain('"message":"User not found"')
    const text = JSON.stringify(entry)
    for (const secret of [
      'leaked-secret',
      'cookie-secret',
      'query-secret',
      'csrf-secret',
      'header-secret',
      'pass',
    ])
      expect(text).not.toContain(secret)
  })

  test('a retried failure is a warning; the body excerpt is cut at 2 KB', async () => {
    const { logger, entries } = recordingLogger()
    const fetcher: typeof fetch = async () =>
      new Response('x'.repeat(10_000), {
        status: 503,
        headers: { 'content-type': 'text/html' },
      })
    await expect(
      traceUpstream(
        {
          logger,
          classify: () => ({ ...final, retryable: true, final: false }),
        },
        async () => {
          await upstream(
            fetcher,
            'https://www.instagram.com/api/v1/media/123/info/',
          )
          throw new Error('unavailable')
        },
      ),
    ).rejects.toThrow()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: levels.warn,
      retryable: true,
      final: false,
      upstream: {
        provider: 'instagram',
        operation: '/api/v1/media/:id/info/',
        status: 503,
      },
    })
    expect(entries[0]!.upstream.body).toHaveLength(2049)
  })

  test('an error in a successful response body is logged with that response', async () => {
    const { logger, entries } = recordingLogger()
    let calls = 0
    const fetcher: typeof fetch = async () =>
      ++calls === 1
        ? Response.json({ code: 200 })
        : Response.json({ code: 404, message: 'User not found' })
    await expect(
      traceUpstream({ logger, classify: () => final }, async () => {
        await upstream(fetcher, 'https://api.fxtwitter.com/2/status/1')
        await upstream(fetcher, 'https://api.fxtwitter.com/2/profile/a')
        throw new Error('not found')
      }),
    ).rejects.toThrow()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.upstream).toMatchObject({
      operation: 'profile',
      status: 200,
      body: '{"code":404,"message":"User not found"}',
    })
  })

  test('a network error is logged; a recovered failure is info', async () => {
    const { logger, entries } = recordingLogger()
    const failing: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const ok: typeof fetch = async () => Response.json({})
    await traceUpstream({ logger, classify: () => final }, async () => {
      await upstream(failing, 'https://api.x.com/graphql/abc/UserTweets').catch(
        () => {},
      )
      await upstream(ok, 'https://api.fxtwitter.com/2/status/1')
    })
    expect(entries).toEqual([
      expect.objectContaining({
        level: levels.info,
        upstream: expect.objectContaining({
          provider: 'x-graphql',
          operation: 'UserTweets',
          error: 'TypeError: fetch failed',
        }),
      }),
    ])
  })

  test('nothing is recorded outside a trace', async () => {
    const response = await upstream(
      async () => new Response('plain'),
      'https://api.fxtwitter.com/2/status/1',
    )
    expect(await response.text()).toBe('plain')
  })

  test('redaction', () => {
    expect(
      redactURL(
        'https://x.com/i/api/graphql/a/B?variables=%7B%7D&csrf=1&sig=2',
      ),
    ).toBe(
      'https://x.com/i/api/graphql/a/B?variables=%7B%7D&csrf=redacted&sig=redacted',
    )
    expect(
      redactText(
        'auth_token=abc; ct0=def "csrftoken":"ghi" Authorization: Bearer AAAA%3Dzz sessionid=jkl',
      ),
    ).toBe(
      'auth_token=[redacted]; ct0=[redacted] "csrftoken":"[redacted]" Authorization: Bearer [redacted] sessionid=[redacted]',
    )
    expect(describeURL('https://x.com/home')).toEqual({
      provider: 'x-web',
      operation: '/home',
    })
  })
})
