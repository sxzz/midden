import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { status } from '../rpc.ts'
import { ProviderError } from './provider.ts'
import { listRelations, relationPageSize } from './relations.ts'
import type { RelationsRequest } from '../platform.ts'

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
          timeline: {
            timeline: {
              instructions: [
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
              ],
            },
          },
        },
      },
    },
  }
}

function source(pages: Record<string, () => Response>) {
  const urls: URL[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    urls.push(url)
    const variables = JSON.parse(url.searchParams.get('variables')!)
    return pages[variables.cursor ?? '']!()
  }
  return { urls, fetcher }
}

const request = (over: Partial<RelationsRequest> = {}): RelationsRequest => ({
  list: 'following',
  externalId: '100',
  cursor: '',
  credential,
  ...over,
})

const signal = () => AbortSignal.timeout(5000)

describe('X following and followers lists', () => {
  test('pages through a list until X stops listing users', async () => {
    const { urls, fetcher } = source({
      '': () => Response.json(page([user('1'), user('2')], '1|next')),
      '1|next': () => Response.json(page([user('3')], '1|last')),
      // Past the end: no users, yet still a fresh cursor.
      '1|last': () => Response.json(page([], '1|more')),
    })
    const pages = []
    let cursor = ''
    for (;;) {
      const result = await listRelations(request({ cursor }), signal(), fetcher)
      pages.push(result.accounts.map((a) => a.externalId))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(pages).toEqual([['1', '2'], ['3'], []])
    expect(urls.map((u) => u.pathname.split('/').pop())).toEqual([
      'Following',
      'Following',
      'Following',
    ])
    const variables = JSON.parse(urls[0]!.searchParams.get('variables')!)
    expect(variables).toMatchObject({
      userId: '100',
      count: relationPageSize,
      cursor: null,
    })
    expect(urls[1]!.searchParams.get('variables')).toContain('1|next')
  })

  test('each listed user is the profile a profile fetch would make', async () => {
    const { fetcher } = source({
      '': () =>
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
    })
    const result = await listRelations(
      request({ list: 'followers' }),
      signal(),
      fetcher,
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

  test('a rate limit says when to ask again', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120
    const { fetcher } = source({
      '': () =>
        new Response('{}', {
          status: 429,
          headers: { 'x-rate-limit-reset': String(reset) },
        }),
    })
    const error = await listRelations(request(), signal(), fetcher).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe(status.UNAVAILABLE)
    const [seconds] = (error as ProviderError).metadata.get('retry-after')
    expect(Number(seconds)).toBeGreaterThan(100)
    expect(Number(seconds)).toBeLessThanOrEqual(120)
  })

  test('needs the account', async () => {
    await expect(
      listRelations(request({ credential: undefined }), signal()),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT })
  })
})
