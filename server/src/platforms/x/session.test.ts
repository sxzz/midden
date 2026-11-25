import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'vitest'
import { status } from '../rpc.ts'
import {
  accountTransport,
  checkSession,
  parseSessionResult,
  unavailableState,
} from './session.ts'

const credential = { authToken: 'a'.repeat(40), csrfToken: 'b'.repeat(64) }
const viewer = (id = '900000000000000002') => ({
  data: {
    viewer: {
      is_tfe_restricted_session: false,
      user_results: {
        result: {
          __typename: 'User',
          rest_id: id,
          core: { screen_name: 'fixture' },
        },
      },
    },
  },
})

test('Viewer verifies the session owner directly, preserving large string IDs', async () => {
  let calls = 0
  const result = await checkSession(
    credential,
    AbortSignal.timeout(1000),
    async (input, init) => {
      calls++
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://api.x.com')
      assert.ok(url.pathname.endsWith('/Viewer'))
      const h = new Headers(init?.headers)
      assert.equal(
        h.get('cookie'),
        `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      )
      assert.equal(h.get('x-client-transaction-id'), null)
      assert.equal(init?.redirect, 'error')
      return Response.json(viewer())
    },
  )
  assert.deepEqual(result, {
    accountId: '900000000000000002',
    username: 'fixture',
  })
  assert.equal(calls, 1)
})

test('post GraphQL never needs the homepage or an inherited transaction ID', async () => {
  const calls: string[] = []
  const transport = accountTransport(credential, AbortSignal.timeout(1000), {
    target: 'post',
    fetcher: async (input, init) => {
      calls.push(String(input))
      assert.equal(
        new Headers(init?.headers).get('x-client-transaction-id'),
        null,
      )
      return Response.json({
        data: { tweetResult: { result: { __typename: 'Tweet' } } },
      })
    },
  })!
  await transport.fetch(
    'https://api.x.com/graphql/fixture/TweetResultByRestId',
    { headers: { 'x-client-transaction-id': 'stale' } },
  )
  assert.deepEqual(calls, [
    'https://api.x.com/graphql/fixture/TweetResultByRestId',
  ])
})

test('required signing does not silently proceed after a homepage challenge', async () => {
  const calls: string[] = []
  const transport = accountTransport(credential, AbortSignal.timeout(1000), {
    target: 'api',
    fetcher: async (input) => {
      calls.push(String(input))
      return new Response('challenge', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
      })
    },
  })!
  await assert.rejects(
    () => transport.fetch('https://api.x.com/graphql/fixture/SearchTimeline'),
    (e: any) =>
      e.code === status.UNAVAILABLE && e.message.includes('浏览器验证'),
  )
  assert.deepEqual(calls, ['https://x.com/home'])
})

test('verification rejects errors and missing identity without fallback', async () => {
  const restricted = viewer()
  restricted.data.viewer.is_tfe_restricted_session = true
  for (const [response, code] of [
    [
      Response.json({ errors: [{ code: 32 }, { code: 215 }] }),
      status.UNAUTHENTICATED,
    ],
    [new Response('', { status: 401 }), status.UNAUTHENTICATED],
    [
      new Response('challenge', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
      }),
      status.UNAVAILABLE,
    ],
    [
      new Response('', { status: 429, headers: { 'retry-after': '10' } }),
      status.UNAVAILABLE,
    ],
    [new Response('', { status: 404 }), status.FAILED_PRECONDITION],
    [Response.json(restricted), status.PERMISSION_DENIED],
    [
      Response.json({ data: { tweetResult: { result: { rest_id: '123' } } } }),
      status.FAILED_PRECONDITION,
    ],
    [Response.json(viewer('not-an-id')), status.FAILED_PRECONDITION],
    [new Response('bad json'), status.UNAVAILABLE],
  ] as const) {
    let calls = 0
    await assert.rejects(
      () =>
        checkSession(credential, AbortSignal.timeout(1000), async () => {
          calls++
          return response
        }),
      (e: any) => e.code === code,
    )
    assert.equal(calls, 1)
  }
})

test('parallel Viewer requests keep account credentials and results separate', async () => {
  const fetcher: typeof fetch = async (_url, init) =>
    Response.json(
      viewer(
        new Headers(init?.headers).get('cookie')!.includes(credential.authToken)
          ? '123'
          : '456',
      ),
    )
  const results = await Promise.all([
    checkSession(credential, AbortSignal.timeout(1000), fetcher),
    checkSession(
      { ...credential, authToken: 'c'.repeat(40) },
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ])
  assert.deepEqual(
    results.map((r) => r.accountId),
    ['123', '456'],
  )
})

const tweet = (id: string, author: string, protectedFlag = false): any => ({
  __typename: 'Tweet',
  rest_id: id,
  core: {
    user_results: {
      result: {
        __typename: 'User',
        rest_id: author,
        legacy: {
          screen_name: `user${author}`,
          name: `User ${author}`,
          protected: protectedFlag,
        },
      },
    },
  },
  legacy: {
    id_str: id,
    full_text: `post ${id}`,
    created_at: 'Mon Jan 01 00:00:00 +0000 2024',
    entities: { urls: [], hashtags: [], user_mentions: [] },
    extended_entities: { media: [] },
  },
})
const quoting = (quoted: any) => {
  const raw = tweet('900123', '42')
  raw.legacy.quoted_status_id_str = '900124'
  raw.quoted_status_result = { result: quoted }
  return raw
}
test('session Fetch lists no restricted embedded posts: their content is not kept', async () => {
  const host = {
    t: (key: string) => key,
    twitterProxy: {
      fetch: async () => {
        throw new Error('Unexpected extra request')
      },
    },
  }
  for (const quoted of [tweet('900124', '43'), tweet('900124', '43', true)]) {
    const result = await parseSessionResult('900123', quoting(quoted), host)
    assert.deepEqual(result.restrictedTargets, [])
    const reference = result.graph!.entities.find(
      (e) => e.externalId === '900124',
    )!
    assert.deepEqual(JSON.parse(Buffer.from(reference.dataJson).toString()), {
      text: '',
    })
  }
})

test("the account's tombstones and unavailable reasons say why a post is gone", () => {
  const tombstone = (text: string) => ({
    __typename: 'TweetTombstone',
    tombstone: { text: { text, entities: [] } },
  })
  assert.equal(
    unavailableState(tombstone('This Post was deleted by the Post author.')),
    'deleted',
  )
  assert.equal(
    unavailableState(tombstone('This Post is from a suspended account.')),
    'suspended',
  )
  assert.equal(
    unavailableState({ __typename: 'TweetUnavailable', reason: 'Suspended' }),
    'suspended',
  )
  // A protected author's post is only unreadable, which is no state.
  assert.equal(
    unavailableState({ __typename: 'TweetUnavailable', reason: 'Protected' }),
    undefined,
  )
  assert.equal(
    unavailableState(
      tombstone('This Post is from an account that limits who can view.'),
    ),
    undefined,
  )
})
