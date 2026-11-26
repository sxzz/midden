import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { rateLimitedKey, type RelationsRequest } from '../platform.ts'
import { status } from '../rpc.ts'
import { recordingLogger } from '#testing/logs.ts'
import { ProviderError } from './provider.ts'
import {
  listRelations,
  relationPageSize,
  type QueryLimits,
  type RelationsDeps,
} from './relations.ts'

const credential = {
  data: Buffer.from(
    JSON.stringify({ auth_token: 'a'.repeat(40), csrf_token: 'b'.repeat(64) }),
  ),
}

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  __typename: 'User',
  rest_id: id,
  core: { screen_name: `user${id}`, name: `User ${id}` },
  avatar: { image_url: `https://pbs.twimg.com/profile_images/${id}/a.jpg` },
  privacy: { protected: false },
  legacy: {
    description: `Bio ${id}`,
    followers_count: 10,
    friends_count: 20,
    statuses_count: 30,
    ...extra,
  },
})

/** A Following/Followers response as X sends it: users, then cursors. */
function page(users: object[], bottom: string) {
  return {
    data: {
      user: {
        result: {
          timeline: { timeline: { instructions: entries(users, bottom) } },
        },
      },
    },
  }
}

/** A `*ByUserIDTimeline` response: the same entries, nested elsewhere. */
function byIdPage(
  list: 'followers' | 'following',
  users: object[],
  bottom: string,
) {
  return {
    data: {
      user_result_by_rest_id: {
        result: {
          [`${list}_timeline`]: {
            timeline: { instructions: entries(users, bottom) },
          },
        },
      },
    },
  }
}

function entries(users: object[], bottom: string) {
  return [
    { type: 'TimelineClearCache' },
    {
      type: 'TimelineAddEntries',
      entries: [
        ...users.map((u: any) => ({
          entryId: `user-${u.rest_id}`,
          content: {
            __typename: 'TimelineTimelineItem',
            itemContent: {
              __typename: 'TimelineUser',
              user_results: { result: u },
            },
          },
        })),
        {
          entryId: 'cursor-top',
          content: {
            __typename: 'TimelineTimelineCursor',
            cursorType: 'Top',
            value: '-1|top',
          },
        },
        {
          entryId: 'cursor-bottom',
          content: {
            __typename: 'TimelineTimelineCursor',
            cursorType: 'Bottom',
            value: bottom,
          },
        },
      ],
    },
  ]
}

/** Requests to X, answered by query name and cursor. */
function source(answer: (query: string, cursor: string, url: URL) => Response) {
  const urls: URL[] = []
  const signed: (string | null)[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    urls.push(url)
    signed.push(new Headers(init?.headers).get('x-client-transaction-id'))
    const variables = JSON.parse(url.searchParams.get('variables')!)
    return answer(url.pathname.split('/').pop()!, variables.cursor ?? '', url)
  }
  return { urls, signed, fetcher }
}

const queriesOf = (urls: URL[]) => urls.map((u) => u.pathname.split('/').pop())

/** Signs as a fake x.com client would; the real one reads the account's page. */
const transactions: RelationsDeps['transactions'] = async () => ({
  generateTransactionId: async (method, path) => `tx ${method} ${path}`,
})

function deps(fetcher: typeof fetch, limits: QueryLimits = new Map()) {
  return { fetcher, transactions, limits }
}

const request = (over: Partial<RelationsRequest> = {}): RelationsRequest => ({
  list: 'following',
  externalId: '100',
  cursor: '',
  providerId: 'x-session',
  credential,
  logger: recordingLogger().logger,
  ...over,
})

const signal = () => AbortSignal.timeout(5000)

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure')
    },
    (error: unknown) => error as ProviderError,
  )

describe('X following and followers lists, with the account', () => {
  test('pages through a list until X stops listing users', async () => {
    const pages: Record<string, () => Response> = {
      '': () => Response.json(page([user('1'), user('2')], '1|next')),
      '1|next': () => Response.json(page([user('3')], '1|last')),
      // Past the end: no users, yet still a fresh cursor.
      '1|last': () => Response.json(page([], '1|more')),
    }
    const { urls, fetcher } = source((_, cursor) => pages[cursor]!())
    const listed = []
    let cursor = ''
    for (;;) {
      const result = await listRelations(
        request({ cursor }),
        signal(),
        deps(fetcher),
      )
      listed.push(result.accounts.map((a) => a.externalId))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(listed).toEqual([['1', '2'], ['3'], []])
    expect(queriesOf(urls)).toEqual(['Following', 'Following', 'Following'])
    const variables = JSON.parse(urls[0]!.searchParams.get('variables')!)
    expect(variables).toMatchObject({
      userId: '100',
      count: relationPageSize,
      cursor: null,
    })
    expect(urls[1]!.searchParams.get('variables')).toContain('1|next')
  })

  test('each listed user is the profile a profile fetch would make', async () => {
    const { fetcher } = source(() =>
      Response.json(
        page(
          [
            user('7', { location: 'Tokyo' }),
            // An entry X cannot show, and the account itself, are left out.
            { __typename: 'UserUnavailable', rest_id: '8' },
            user('100'),
          ],
          '0|end',
        ),
      ),
    )
    const result = await listRelations(
      request({ list: 'followers' }),
      signal(),
      deps(fetcher),
    )
    // A `0|` cursor marks the end.
    expect(result.nextCursor).toBe('')
    expect(result.accounts).toHaveLength(1)
    const [account] = result.accounts
    expect(account!.canonicalTarget).toMatchObject({
      url: 'https://x.com/i/user/7',
      externalId: '7',
    })
    const root = account!.graph!.entities.find(
      (e) => e.key === account!.graph!.root,
    )!
    expect(root.type).toBe('x.profile')
    expect(JSON.parse(Buffer.from(root.dataJson).toString())).toMatchObject({
      username: 'user7',
      name: 'User 7',
      metadata: {
        description: 'Bio 7',
        location: 'Tokyo',
        protected: false,
        followers: 10,
        following: 20,
      },
    })
    expect(account!.resources.map((r) => r.purpose)).toEqual(['avatar'])
  })

  test('Followers and Following carry a transaction ID; the *ByUserIDTimeline queries do not', async () => {
    const { urls, signed, fetcher } = source((query) => {
      if (query === 'Followers')
        return new Response('Rate limit exceeded', { status: 429 })
      return Response.json(
        query === 'FollowersByUserIDTimeline'
          ? byIdPage('followers', [user('1')], '0|end')
          : page([user('1')], '0|end'),
      )
    })
    await listRelations(request(), signal(), deps(fetcher))
    await listRelations(request({ list: 'followers' }), signal(), deps(fetcher))
    expect(queriesOf(urls)).toEqual([
      'Following',
      'Followers',
      'FollowersByUserIDTimeline',
    ])
    expect(signed).toEqual([
      `tx GET ${urls[0]!.pathname}`,
      `tx GET ${urls[1]!.pathname}`,
      null,
    ])
  })

  test('a 404 from X is a refused request, not a missing post', async () => {
    const { fetcher } = source(() => new Response('', { status: 404 }))
    const error = await failure(
      listRelations(request({ list: 'followers' }), signal(), deps(fetcher)),
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.code).toBe(status.FAILED_PRECONDITION)
    expect(error.message).toBe('X 接口请求被拒绝')
  })

  test('a 429 moves the same page to the other query, which later pages ask first', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600
    const { urls, fetcher } = source((query, cursor) => {
      if (query === 'Followers')
        // X answers a rate limit in plain text, not JSON.
        return new Response('Rate limit exceeded\n', {
          status: 429,
          headers: {
            'content-type': 'text/plain',
            'x-rate-limit-reset': String(reset),
          },
        })
      return Response.json(
        cursor
          ? byIdPage('followers', [user('2')], '0|end')
          : byIdPage('followers', [user('1')], '1|next'),
      )
    })
    const limits: QueryLimits = new Map()
    const { logger, entries } = recordingLogger()
    const first = await listRelations(
      request({ list: 'followers', logger }),
      signal(),
      deps(fetcher, limits),
    )
    expect(first.accounts.map((a) => a.externalId)).toEqual(['1'])
    expect(first.nextCursor).toBe('1|next')
    const second = await listRelations(
      request({ list: 'followers', cursor: first.nextCursor, logger }),
      signal(),
      deps(fetcher, limits),
    )
    expect(second.accounts.map((a) => a.externalId)).toEqual(['2'])
    expect(second.nextCursor).toBe('')
    expect(queriesOf(urls)).toEqual([
      'Followers',
      'FollowersByUserIDTimeline',
      // Followers is still limited: not asked again.
      'FollowersByUserIDTimeline',
    ])
    // The other query gets the same page: its own variable, the same cursor.
    expect(JSON.parse(urls[1]!.searchParams.get('variables')!)).toMatchObject({
      rest_id: '100',
      cursor: null,
    })
    expect(JSON.parse(urls[2]!.searchParams.get('variables')!)).toMatchObject({
      rest_id: '100',
      cursor: '1|next',
    })
    expect(
      entries
        .filter((e) => e.msg.includes('switching'))
        .map((e) => [e.from, e.to]),
    ).toEqual([['Followers', 'FollowersByUserIDTimeline']])
  })

  test('when both queries are limited, the failure says to wait for the earlier reset', async () => {
    const now = Math.floor(Date.now() / 1000)
    const resets: Record<string, number> = {
      Following: now + 900,
      FollowingByUserIDTimeline: now + 300,
    }
    const { urls, fetcher } = source(
      (query) =>
        new Response('Rate limit exceeded', {
          status: 429,
          headers: { 'x-rate-limit-reset': String(resets[query]) },
        }),
    )
    const limits: QueryLimits = new Map()
    const error = await failure(
      listRelations(request(), signal(), deps(fetcher, limits)),
    )
    expect(error.code).toBe(status.UNAVAILABLE)
    expect(error.metadata.get(rateLimitedKey)).toEqual(['1'])
    const [seconds] = error.metadata.get('retry-after')
    expect(Number(seconds)).toBeGreaterThan(290)
    expect(Number(seconds)).toBeLessThanOrEqual(300)
    // Until a reset passes, neither is asked again.
    const again = await failure(
      listRelations(request(), signal(), deps(fetcher, limits)),
    )
    expect(again.metadata.get(rateLimitedKey)).toEqual(['1'])
    expect(queriesOf(urls)).toEqual(['Following', 'FollowingByUserIDTimeline'])
  })

  test('a limit without a reset time still says it is one', async () => {
    const { fetcher } = source(
      () => new Response('Rate limit exceeded', { status: 429 }),
    )
    const error = await failure(
      listRelations(request(), signal(), deps(fetcher)),
    )
    expect(error.code).toBe(status.UNAVAILABLE)
    // The core waits its fallback (`FALLBACK_LIMIT_MS`).
    expect(error.metadata.get(rateLimitedKey)).toEqual(['1'])
    expect(error.metadata.get('retry-after')).toEqual([])
  })

  test('needs the account', async () => {
    await expect(
      listRelations(request({ credential: undefined }), signal()),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT })
  })
})

/** A FxTwitter list user, as the public instance returns it. */
const fxUser = (id: string, extra: Record<string, unknown> = {}) => ({
  screen_name: `user${id}`,
  url: `https://x.com/user${id}`,
  id,
  followers: 10,
  following: 20,
  likes: 1,
  media_count: 2,
  statuses: 30,
  name: `User ${id}`,
  description: `Bio ${id}`,
  raw_description: { text: `Bio ${id}`, facets: [] },
  location: '',
  banner_url: `https://pbs.twimg.com/profile_banners/${id}/1`,
  avatar_url: `https://pbs.twimg.com/profile_images/${id}/a_normal.jpg`,
  joined: 'Tue Oct 11 17:17:44 +0000 2011',
  protected: false,
  website: null,
  verification: { verified: false, verified_at: null, type: null },
  type: 'profile',
  ...extra,
})

function publicSource(answer: (url: URL) => Response) {
  const urls: URL[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    urls.push(url)
    // No account goes to the public instance.
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    return answer(url)
  }
  return { urls, fetcher }
}

const publicRequest = (over: Partial<RelationsRequest> = {}) =>
  request({ providerId: 'fxtwitter', credential: undefined, ...over })

describe('public account lists, from FxTwitter', () => {
  test('pages with the bottom cursor until no users are listed', async () => {
    const { urls, fetcher } = publicSource((url) => {
      const cursor = url.searchParams.get('cursor')
      return Response.json(
        cursor
          ? cursor === '17|b+c'
            ? {
                code: 200,
                results: [fxUser('3')],
                cursor: { top: '-1|a', bottom: '18|d' },
              }
            : { code: 200, results: [], cursor: { top: null, bottom: '19|e' } }
          : {
              code: 200,
              results: [fxUser('1'), fxUser('2')],
              cursor: { top: '-1|a', bottom: '17|b+c' },
            },
      )
    })
    const listed = []
    let cursor = ''
    for (;;) {
      const result = await listRelations(
        publicRequest({ list: 'followers', cursor }),
        signal(),
        { fetcher },
      )
      listed.push(result.accounts.map((a) => a.externalId))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(listed).toEqual([['1', '2'], ['3'], []])
    expect(urls.map((u) => u.href)).toEqual([
      'https://api.fxtwitter.com/2/profile/id:100/followers',
      'https://api.fxtwitter.com/2/profile/id:100/followers?cursor=17%7Cb%2Bc',
      'https://api.fxtwitter.com/2/profile/id:100/followers?cursor=18%7Cd',
    ])
  })

  test('an unchanged or `0|` cursor ends the list', async () => {
    for (const bottom of ['0|end', '5|same']) {
      const { fetcher } = publicSource(() =>
        Response.json({
          code: 200,
          results: [fxUser('1')],
          cursor: { top: null, bottom },
        }),
      )
      const result = await listRelations(
        publicRequest({ cursor: '5|same' }),
        signal(),
        { fetcher },
      )
      expect(result.nextCursor).toBe('')
    }
  })

  test('each user becomes the profile a public profile fetch would make', async () => {
    const { fetcher } = publicSource(() =>
      Response.json({
        code: 200,
        results: [
          fxUser('7', { location: 'Tokyo' }),
          // The account itself and an entry without a valid id are left out.
          fxUser('100'),
          fxUser('x'),
        ],
        cursor: { top: null, bottom: '0|end' },
      }),
    )
    const result = await listRelations(publicRequest(), signal(), { fetcher })
    expect(result.accounts).toHaveLength(1)
    const [account] = result.accounts
    expect(account).toMatchObject({
      externalId: '7',
      providerId: 'fxtwitter',
      textSource: 'fxtwitter',
      canonicalTarget: { url: 'https://x.com/i/user/7', externalId: '7' },
    })
    const root = account!.graph!.entities.find(
      (e) => e.key === account!.graph!.root,
    )!
    expect(root.type).toBe('x.profile')
    expect(JSON.parse(Buffer.from(root.dataJson).toString())).toMatchObject({
      username: 'user7',
      name: 'User 7',
      metadata: {
        description: 'Bio 7',
        location: 'Tokyo',
        protected: false,
        followers: 10,
        following: 20,
      },
    })
    expect(
      account!.resources.map((r) => [r.purpose, r.url.split('/', 4)[3]]),
    ).toEqual([
      ['avatar', 'profile_images'],
      ['banner', 'profile_banners'],
    ])
  })

  test('every failure is transient, with the reason in its message', async () => {
    for (const [response, message, retry] of [
      [
        new Response('', { status: 500 }),
        'FxTwitter 公共接口返回 HTTP 500',
        [],
      ],
      [
        new Response('', { status: 404 }),
        'FxTwitter 公共接口返回 HTTP 404',
        [],
      ],
      [
        new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
        'FxTwitter 公共接口限流',
        ['30'],
      ],
      [
        Response.json({ code: 500, results: [], cursor: {} }),
        'FxTwitter 公共接口返回错误（code 500）',
        [],
      ],
      [new Response('<html>'), 'FxTwitter 公共接口返回的数据无效', []],
    ] as const) {
      const { fetcher } = publicSource(() => response)
      const error = await failure(
        listRelations(publicRequest(), signal(), { fetcher }),
      )
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.code).toBe(status.UNAVAILABLE)
      expect(error.message).toBe(message)
      expect(error.metadata.get('retry-after')).toEqual(retry)
      // Only a 429 is a rate limit, which the core waits for.
      expect(error.metadata.get(rateLimitedKey)).toEqual(
        message === 'FxTwitter 公共接口限流' ? ['1'] : [],
      )
    }
  })
})
