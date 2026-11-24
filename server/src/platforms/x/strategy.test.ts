import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { FetchRequest, FetchResponse, Visibility } from '../protocol.ts'
import {
  fetchPublicTimeline,
  fetchSessionTimeline,
  normalizeProfile,
} from './profile.ts'
import { parseSessionResult } from './session.ts'
import { CaptureStrategy } from './strategy.ts'
const credential = { authToken: 'a'.repeat(40), csrfToken: 'b'.repeat(64) }
const request = (kind = 'post', providerId = 'x-session') =>
  FetchRequest.fromPartial({
    url:
      kind === 'post'
        ? 'https://x.com/fixture/status/42'
        : 'https://x.com/fixture',
    externalId: kind === 'post' ? '42' : 'handle:fixture',
    platform: 'x',
    kind,
    providerId,
  })
const user = {
  id: '123',
  type: 'profile',
  name: 'Fixture',
  screen_name: 'fixture',
  protected: false,
}
const post = (providerId: string) =>
  FetchResponse.fromPartial({
    externalId: '42',
    providerId,
    text: 'Body',
    visibility: Visibility.VISIBILITY_PUBLIC,
    graph: {
      root: 'post',
      entities: [
        {
          key: 'post',
          externalId: '42',
          type: 'x.post',
          dataJson: Buffer.from('{"text":"Body"}'),
        },
        {
          key: 'author',
          externalId: '123',
          type: 'x.profile',
          dataJson: Buffer.from('{}'),
        },
      ],
      relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
    },
  })
test('public profiles precede post selection, even when an account is selected; cache expires after one minute', async () => {
  let now = 0
  const calls: string[] = []
  const strategy = new CaptureStrategy(
    async () => {
      calls.push('public-post')
      return post('fxtwitter')
    },
    async (id) => {
      calls.push('public-profile')
      return normalizeProfile(user, id, 'fxtwitter')
    },
    async () => {
      throw new Error('must not use account')
    },
    undefined,
    () => now,
  )
  const r = await strategy.fetch(
    request(),
    AbortSignal.timeout(1000),
    credential,
  )
  assert.deepEqual(calls, ['public-profile', 'public-post'])
  assert.equal(r.providerId, 'x-session')
  now = 59_999
  await strategy.fetch(request(), AbortSignal.timeout(1000), credential)
  assert.equal(calls.filter((c) => c === 'public-profile').length, 1)
  now = 60_000
  await strategy.fetch(request(), AbortSignal.timeout(1000), credential)
  assert.equal(calls.filter((c) => c === 'public-profile').length, 2)
  assert.equal(r.relatedTargets[0].refreshAfterSeconds, 60)
})
test('protected posts use the selected account after public profile lookup', async () => {
  const calls: string[] = []
  const strategy = new CaptureStrategy(
    async () => {
      throw new Error('must not fetch public post')
    },
    async (id) => {
      calls.push('public-profile')
      return normalizeProfile({ ...user, protected: true }, id, 'fxtwitter')
    },
    async () => {
      calls.push('account-post')
      return {
        ...post('x-session'),
        visibility: Visibility.VISIBILITY_PRIVATE,
      }
    },
  )
  const r = await strategy.fetch(
    request(),
    AbortSignal.timeout(1000),
    credential,
  )
  assert.deepEqual(calls, ['public-profile', 'account-post'])
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE)
  await assert.rejects(
    () =>
      strategy.fetch(request('post', 'fxtwitter'), AbortSignal.timeout(1000)),
    /受保护/,
  )
})
test('explicit profile always refreshes and routes timeline by protection', async () => {
  let profiles = 0
  let publicTimelines = 0
  let privateTimelines = 0
  let protectedUser = false
  const strategy = new CaptureStrategy(
    undefined,
    async (id) => {
      profiles++
      return normalizeProfile(
        { ...user, protected: protectedUser },
        id,
        'fxtwitter',
      )
    },
    undefined,
    async () => {
      privateTimelines++
    },
  )
  strategy.timeline = async () => {
    publicTimelines++
  }
  await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  assert.equal(profiles, 2)
  assert.equal(publicTimelines, 2)
  assert.equal(privateTimelines, 0)
  protectedUser = true
  const r = await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  assert.equal(privateTimelines, 1)
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE)
  await strategy.fetch(
    { ...request('profile'), externalId: '123', automatic: true },
    AbortSignal.timeout(1000),
    credential,
  )
  assert.equal(profiles, 3)
  assert.equal(privateTimelines, 1)
})
test('ID-only posts discover their author, then refresh profile without fetching post twice', async () => {
  const calls: string[] = []
  const strategy = new CaptureStrategy(
    async () => {
      calls.push('post-discovery')
      return post('fxtwitter')
    },
    async (id) => {
      calls.push('profile')
      assert.equal(id, '123')
      return normalizeProfile(user, id, 'fxtwitter')
    },
  )
  await strategy.fetch(
    { ...request('post', 'fxtwitter'), url: 'https://x.com/i/web/status/42' },
    AbortSignal.timeout(1000),
  )
  assert.deepEqual(calls, ['post-discovery', 'profile'])
})
test('private timeline requests count 100 and retains raw response privately', async () => {
  const urls: string[] = []
  const raw = JSON.stringify({
    data: {
      user: { result: { timeline_v2: { timeline: { instructions: [] } } } },
    },
  })
  const r = normalizeProfile({ ...user, protected: true }, '123', 'fxtwitter')
  await fetchSessionTimeline(
    r,
    credential,
    AbortSignal.timeout(2000),
    async (input, init) => {
      const url = new URL(String(input))
      urls.push(url.href)
      assert.equal(JSON.parse(url.searchParams.get('variables')!).count, 100)
      assert.ok(new Headers(init?.headers).get('cookie'))
      return new Response(raw, {
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  assert.ok(urls.length > 0)
  assert.ok(r.sourceResponses.length > 0)
  assert.ok(
    r.sourceResponses.every(
      (s) => s.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
  )
  assert.equal(Buffer.from(r.sourceResponses[0].body).toString(), raw)
})

test('ID-only public 401 falls back to selected account then refreshes profile publicly', async () => {
  const { responseError } = await import('./provider.ts')
  const calls: string[] = []
  const strategy = new CaptureStrategy(
    async () => {
      calls.push('public-post')
      throw responseError(401, null, 'post')
    },
    async (id) => {
      calls.push('public-profile')
      return normalizeProfile({ ...user, protected: true }, id, 'fxtwitter')
    },
    async () => {
      calls.push('private-post')
      return {
        ...post('x-session'),
        visibility: Visibility.VISIBILITY_PRIVATE,
      }
    },
  )
  const r = await strategy.fetch(
    { ...request(), url: 'https://x.com/i/web/status/42' },
    AbortSignal.timeout(1000),
    credential,
  )
  assert.deepEqual(calls, ['public-post', 'private-post', 'public-profile'])
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE)
  for (const code of [403, 404, 429, 500]) {
    let privateCalls = 0
    const failing = new CaptureStrategy(
      async () => {
        throw responseError(code, null, 'post')
      },
      undefined,
      async () => {
        privateCalls++
        return post('x-session')
      },
    )
    await assert.rejects(() =>
      failing.fetch(
        { ...request(), url: 'https://x.com/i/web/status/42' },
        AbortSignal.timeout(1000),
        credential,
      ),
    )
    assert.equal(privateCalls, 0)
  }
})

test('profile continuation is bound to user and public/private source', async () => {
  const strategy = new CaptureStrategy(undefined, async (id) =>
    normalizeProfile(user, id, 'fxtwitter'),
  )
  const cursors: string[] = []
  strategy.timeline = async (result, _signal, _fetcher, cursor = '') => {
    cursors.push(cursor)
    result.nextPageCursor = cursor ? '' : 'page-two'
  }
  const first = await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  const second = await strategy.fetch(
    { ...request('profile'), pageCursor: first.nextPageCursor },
    AbortSignal.timeout(1000),
    credential,
  )
  assert.deepEqual(cursors, ['', 'page-two'])
  assert.equal(first.maxBatchSize, 1000)
  assert.equal(second.nextPageCursor, '')
  for (const token of [
    'invalid',
    JSON.stringify({ user: 'other', mode: 'public', cursor: 'page-two' }),
    JSON.stringify({ user: '123', mode: 'private', cursor: 'page-two' }),
  ]) {
    await assert.rejects(
      strategy.fetch(
        { ...request('profile'), pageCursor: token },
        AbortSignal.timeout(1000),
        credential,
      ),
    )
  }
  strategy.timeline = async (result) => {
    result.nextPageCursor = 'page-two'
  }
  assert.equal(
    (
      await strategy.fetch(
        { ...request('profile'), pageCursor: first.nextPageCursor },
        AbortSignal.timeout(1000),
        credential,
      )
    ).nextPageCursor,
    '',
  )
})

test('protected continuation requests 100 and never advertises bulk collection', async () => {
  const strategy = new CaptureStrategy(
    undefined,
    async (id) =>
      normalizeProfile({ ...user, protected: true }, id, 'fxtwitter'),
    undefined,
    async (
      result,
      _credential,
      signal,
      _fetcher,
      cursor = '',
      pageSize = 0,
    ) => {
      await fetchSessionTimeline(
        result,
        credential,
        signal,
        async (input) => {
          const variables = JSON.parse(
            new URL(String(input)).searchParams.get('variables')!,
          )
          assert.equal(variables.count, 100)
          assert.equal(variables.cursor, 'protected-next')
          return Response.json({
            data: {
              user: {
                result: { timeline_v2: { timeline: { instructions: [] } } },
              },
            },
          })
        },
        cursor,
        pageSize,
      )
    },
  )
  const result = await strategy.fetch(
    {
      ...request('profile'),
      pageCursor: JSON.stringify({
        user: '123',
        mode: 'private',
        cursor: 'protected-next',
      }),
    },
    AbortSignal.timeout(2000),
    credential,
  )
  assert.equal(result.maxBatchSize, 0)
})

test('public timeline always uses FxTwitter public instance with a selected account', async () => {
  let privateCalls = 0
  const strategy = new CaptureStrategy(
    undefined,
    async (id) => normalizeProfile(user, id, 'fxtwitter'),
    undefined,
    async () => {
      privateCalls++
    },
  )
  let responseStatus = 200
  const requests: URL[] = []
  strategy.timeline = async (result, signal, _fetcher, cursor, pageSize) => {
    await fetchPublicTimeline(
      result,
      signal,
      async (input, init) => {
        const url = new URL(String(input))
        requests.push(url)
        assert.equal(url.origin, 'https://api.fxtwitter.com')
        assert.equal(url.pathname, '/2/profile/id:123/statuses')
        assert.equal(url.searchParams.get('count'), '100')
        assert.equal(new Headers(init?.headers).has('cookie'), false)
        return Response.json(
          {
            code: 200,
            results: Array.from({ length: 100 }, (_, i) => ({
              type: 'status',
              id: String(i + 1),
            })),
            cursor: { bottom: 'next' },
          },
          { status: responseStatus },
        )
      },
      cursor,
      pageSize,
    )
  }
  const first = await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  for (const pageSize of [0, 1000]) {
    await strategy.fetch(
      { ...request('profile'), pageCursor: first.nextPageCursor, pageSize },
      AbortSignal.timeout(1000),
      credential,
    )
  }
  responseStatus = 401
  const failed = await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
    credential,
  )
  assert.equal(failed.incomplete, true)
  assert.deepEqual(
    requests.map((url) => url.searchParams.get('cursor')),
    [null, 'next', 'next', null],
  )
  assert.equal(privateCalls, 0)
})

test('full author hydration preserves post mentions and captures mentions from the richer bio', async () => {
  const { normalize } = await import('./provider.ts')
  const strategy = new CaptureStrategy(
    async () =>
      normalize(
        {
          type: 'status',
          id: '42',
          text: 'Hi @Mentioned',
          author: user,
          media: { all: [] },
        },
        '42',
        'fxtwitter',
        Visibility.VISIBILITY_PUBLIC,
      ),
    async (id) =>
      normalizeProfile(
        { ...user, description: 'With @BioFriend' },
        id,
        'fxtwitter',
      ),
  )
  const result = await strategy.fetch(
    request('post', 'fxtwitter'),
    AbortSignal.timeout(1000),
  )
  assert.deepEqual(
    new Set(result.relatedTargets.map((target) => target.url)),
    new Set([
      'https://x.com/i/user/123',
      'https://x.com/mentioned',
      'https://x.com/biofriend',
    ]),
  )
  assert.equal(
    result.graph!.relations.filter((relation) => relation.type === 'mentions')
      .length,
    2,
  )
})

test('a post the account cannot read is reported gone when the public API says so', async () => {
  const { responseError, sourceState } = await import('./provider.ts')
  const { status } = await import('../rpc.ts')
  let publicCode = 404
  const strategy = new CaptureStrategy(
    async () => {
      const error = responseError(publicCode, null, 'post')
      if (publicCode === 404) error.metadata.set('source-state', 'deleted')
      throw error
    },
    async (id) =>
      normalizeProfile({ ...user, protected: true }, id, 'fxtwitter'),
    async () => {
      throw responseError(403, null, 'post')
    },
  )
  const fetch = () =>
    strategy.fetch(request(), AbortSignal.timeout(1000), credential).then(
      () => assert.fail('expected a failure'),
      (error) => error,
    )
  assert.equal(sourceState(await fetch()), 'deleted')
  publicCode = 401
  const denied = await fetch()
  assert.equal(denied.code, status.PERMISSION_DENIED)
  assert.equal(sourceState(denied), undefined)
})
test("a renamed or suspended handle falls back to the post's own answer", async () => {
  const { responseError, sourceState } = await import('./provider.ts')
  const strategy = new CaptureStrategy(
    async () => {
      throw responseError(404, null, 'post', 'suspended')
    },
    async () => {
      throw responseError(404, null, 'profile', 'suspended')
    },
  )
  const error = await strategy
    .fetch(request('post', 'fxtwitter'), AbortSignal.timeout(1000))
    .then(
      () => assert.fail('expected a failure'),
      (e) => e,
    )
  assert.equal(sourceState(error), 'suspended')
  const calls: string[] = []
  const renamed = new CaptureStrategy(
    async () => {
      calls.push('public-post')
      return post('fxtwitter')
    },
    async (id) => {
      calls.push(`profile:${id}`)
      if (id.startsWith('handle:')) throw responseError(404, null, 'profile')
      return normalizeProfile(user, id, 'fxtwitter')
    },
  )
  await renamed.fetch(request('post', 'fxtwitter'), AbortSignal.timeout(1000))
  assert.deepEqual(calls, [
    'profile:handle:fixture',
    'public-post',
    'profile:123',
  ])
})
test('posts listed by a public timeline are captured without a request of their own', async () => {
  const listedPost = JSON.parse(
    readFileSync(new URL('testdata/post.json', import.meta.url), 'utf8'),
  ).status
  let now = Date.now()
  const posts: string[] = []
  let profiles = 0
  const strategy = new CaptureStrategy(
    async (id) => {
      posts.push(id)
      return post('fxtwitter')
    },
    async (id) => {
      profiles++
      return normalizeProfile(
        { ...user, id: id.startsWith('handle:') ? user.id : id },
        id,
        'fxtwitter',
      )
    },
    undefined,
    undefined,
    () => now,
  )
  let page = ''
  strategy.timeline = (result, signal, _fetcher, cursor, size) =>
    fetchPublicTimeline(
      result,
      signal,
      async (input) => {
        page = String(input)
        return Response.json({
          code: 200,
          results: [
            {
              ...listedPost,
              reposted_by: { id: '123', screen_name: 'fixture' },
            },
            { ...listedPost, id: '43', article: {} },
          ],
          cursor: {},
        })
      },
      cursor,
      size,
    )
  const profile = await strategy.fetch(
    request('profile'),
    AbortSignal.timeout(1000),
  )
  // The core hands each target's prefetch to the capture it creates.
  const member = (id: string) => ({
    ...request('post', 'fxtwitter'),
    url: `https://x.com/i/web/status/${id}`,
    externalId: id,
    automatic: true,
    prefetch: profile.relatedTargets.find((t) => t.url.endsWith(`/${id}`))!
      .prefetch,
  })
  assert.equal(member('43').prefetch.length, 0)
  const listed = await strategy.fetch(
    member(listedPost.id),
    AbortSignal.timeout(1000),
  )
  assert.deepEqual(posts, [])
  // The listing also describes the author: only the timeline's profile was asked for.
  assert.equal(profiles, 1)
  const author = listed.graph!.entities.find((e) => e.key === 'author')!
  assert.equal(
    JSON.parse(Buffer.from(author.dataJson).toString()).metadata.id,
    listedPost.author.id,
  )
  assert.equal(listed.text, listedPost.text)
  assert.equal(listed.sourceResponses[0].sourceUrl, page)
  assert.equal(
    JSON.parse(Buffer.from(listed.sourceResponses[0].body).toString()).id,
    listedPost.id,
  )
  // The repost belongs to the timeline, not to the post.
  assert.equal(
    listed.graph!.relations.some((r) => r.type === 'reposted'),
    false,
  )
  // Explicit captures, articles and stale listings ask upstream.
  await strategy.fetch(
    { ...member(listedPost.id), automatic: false },
    AbortSignal.timeout(1000),
  )
  await strategy.fetch(member('43'), AbortSignal.timeout(1000))
  now += 61 * 60_000
  await strategy.fetch(member(listedPost.id), AbortSignal.timeout(1000))
  assert.deepEqual(posts, [listedPost.id, '43', listedPost.id])
})
test('a deferred account is asked for only when the fetch needs it', async () => {
  let protectedUser = false
  let now = 0
  const sessions: string[] = []
  const strategy = new CaptureStrategy(
    async () => ({
      ...post('fxtwitter'),
      sourceResponses: [
        {
          body: Buffer.from('{}'),
          contentType: 'application/json',
          sourceUrl: '',
          visibility: Visibility.VISIBILITY_PUBLIC,
        },
      ],
    }),
    async (id) =>
      normalizeProfile({ ...user, protected: protectedUser }, id, 'fxtwitter'),
    async (id) => {
      sessions.push(id)
      return post('x-session')
    },
    undefined,
    () => now,
  )
  const deferred = { ...request(), credentialDeferred: true }
  const open = await strategy.fetch(deferred, AbortSignal.timeout(1000))
  // What an account's capture returns stays private, with or without the account.
  assert.equal(
    open.sourceResponses.every(
      (source) => source.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
    true,
  )
  protectedUser = true
  now = 61_000
  await assert.rejects(
    strategy.fetch(
      { ...deferred, url: 'https://x.com/i/web/status/42' },
      AbortSignal.timeout(1000),
    ),
    (error: any) =>
      error.metadata.get('credential-required')[0] === '1' &&
      sessions.length === 0,
  )
  await strategy.fetch(deferred, AbortSignal.timeout(1000), credential)
  assert.deepEqual(sessions, ['42'])
})
const rawTweet = (id: string, author = '123'): any => ({
  __typename: 'Tweet',
  rest_id: id,
  core: {
    user_results: {
      result: {
        __typename: 'User',
        rest_id: author,
        legacy: { screen_name: 'fixture', name: 'Fixture', protected: true },
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
test("an account's timeline hands each post its raw node, a repost the reposted one", async () => {
  const repost = rawTweet('51')
  repost.legacy.retweeted_status_result = { result: rawTweet('41', '456') }
  const publicRepost = rawTweet('52')
  const publicOriginal = rawTweet('39', '789')
  publicOriginal.core.user_results.result.legacy.protected = false
  publicRepost.legacy.retweeted_status_result = { result: publicOriginal }
  const entry = (result: any) => ({
    content: {
      itemContent: { __typename: 'TimelineTweet', tweet_results: { result } },
    },
  })
  const r = normalizeProfile({ ...user, protected: true }, '123', 'fxtwitter')
  await fetchSessionTimeline(
    r,
    credential,
    AbortSignal.timeout(2000),
    async () =>
      Response.json({
        data: {
          user: {
            result: {
              timeline: {
                timeline: {
                  instructions: [
                    {
                      type: 'TimelineAddEntries',
                      entries: [
                        entry(rawTweet('40')),
                        entry(repost),
                        entry(publicRepost),
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      }),
  )
  const prefetched = (id: string) =>
    JSON.parse(
      Buffer.from(
        r.relatedTargets.find((t) => t.url.endsWith(`/${id}`))!.prefetch,
      ).toString(),
    )
  assert.equal(prefetched('40').source, 'x-session')
  assert.equal(prefetched('40').node.rest_id, '40')
  assert.equal(prefetched('41').node.rest_id, '41')
  assert.equal(
    r.relatedTargets.some((t) => t.url.endsWith('/51')),
    false,
  )
  // A public author's post is read from the public API like any public post.
  assert.equal(
    r.relatedTargets.find((t) => t.url.endsWith('/39'))!.prefetch.length,
    0,
  )
})
test("an account's timeline lists reposts at their repost time and marks the pinned post", async () => {
  const at = (date: string) => `${date} 00:00:00 +0000 2026`
  const tweet = (id: string, created: string, author = '123') => {
    const node = rawTweet(id, author)
    node.legacy.created_at = at(created)
    return node
  }
  const repost = tweet('51', 'Mon Nov 23')
  repost.legacy.retweeted_status_result = {
    result: tweet('41', 'Thu Jan 01', '456'),
  }
  const entry = (result: any, extra = {}) => ({
    content: {
      itemContent: {
        __typename: 'TimelineTweet',
        tweet_results: { result },
        ...extra,
      },
    },
  })
  const read = async (since: string) => {
    const r = normalizeProfile({ ...user, protected: true }, '123', 'fxtwitter')
    const cursors: string[] = []
    await fetchSessionTimeline(
      r,
      credential,
      AbortSignal.timeout(2000),
      async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        cursors.push(JSON.parse(url.searchParams.get('variables')!).cursor)
        return Response.json({
          data: {
            user: {
              result: {
                timeline: {
                  timeline: {
                    instructions: [
                      {
                        type: 'TimelinePinEntry',
                        entry: entry(tweet('10', 'Fri Jan 02')),
                      },
                      {
                        type: 'TimelineAddEntries',
                        entries: [
                          entry(tweet('60', 'Tue Nov 24')),
                          entry(repost),
                          entry(tweet('70', 'Sat Jan 03'), {
                            promotedMetadata: {},
                          }),
                          {
                            entryId: 'cursor-bottom-1',
                            content: {
                              __typename: 'TimelineTimelineCursor',
                              cursorType: 'Bottom',
                              value: 'next-page',
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
        })
      },
      '',
      100,
      since,
    )
    return { r, cursors }
  }
  // Past the pinned post and the repost's original, but not the repost.
  const { r, cursors } = await read('2026-11-20T00:00:00Z')
  const target = (id: string) =>
    r.relatedTargets.find((t) => t.url.endsWith(`/${id}`))!
  assert.equal(target('10').pinned, true)
  assert.equal(target('60').pinned, false)
  assert.equal(target('60').listedAt, '2026-11-24T00:00:00.000Z')
  // The repost lists the original, published long before it was reposted.
  assert.equal(target('41').publishedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(target('41').listedAt, '2026-11-23T00:00:00.000Z')
  assert.equal(target('70').listedAt, '')
  // Read on; the second page lists nothing new, which ends the timeline.
  assert.deepEqual(cursors, [null, 'next-page'])
  // The repost, the last post with a known time, is past this cutoff.
  const past = await read('2026-11-23T12:00:00Z')
  assert.deepEqual(past.cursors, [null])
  assert.equal(past.r.nextPageCursor, 'next-page')
})
test("a post listed by an account's timeline needs neither its own request nor the account", async () => {
  const sessions: string[] = []
  let profiles = 0
  const strategy = new CaptureStrategy(
    async () => {
      throw new Error('no public request expected')
    },
    async (id) => {
      profiles++
      return normalizeProfile({ ...user, protected: true }, id, 'fxtwitter')
    },
    async (id) => {
      sessions.push(id)
      return post('x-session')
    },
  )
  const listed = (node: any) =>
    FetchRequest.fromPartial({
      ...request(),
      url: 'https://x.com/i/web/status/42',
      automatic: true,
      credentialDeferred: true,
      prefetch: Buffer.from(
        JSON.stringify({
          source: 'x-session',
          observed_at: new Date().toISOString(),
          source_url: 'https://x.com/i/api/graphql/UserTweets',
          node,
        }),
      ),
    })
  const result = await strategy.fetch(
    listed(rawTweet('42')),
    AbortSignal.timeout(1000),
  )
  assert.deepEqual(sessions, [])
  assert.equal(profiles, 1)
  assert.equal(result.text, 'post 42')
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE)
  assert.equal(
    result.sourceResponses.every(
      (s) => s.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
    true,
  )
  // A post whose building asks upstream needs the account, as its own
  // response would.
  strategy.sessionListed = async (id, raw, host) => {
    await host.twitterProxy!.fetch('https://x.com/i/api/1.1/live', {})
    return parseSessionResult(id, raw, host)
  }
  await assert.rejects(
    strategy.fetch(listed(rawTweet('42')), AbortSignal.timeout(1000)),
    (error: any) => error.metadata.get('credential-required')[0] === '1',
  )
})
