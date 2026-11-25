import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'vitest'
import { FetchRequest, Visibility, type FetchResponse } from '../protocol.ts'
import { status } from '../rpc.ts'
import { InstagramClient, type Node } from './client.ts'
import { decodeCredential, prepareCredential } from './credential.ts'
import { postResult } from './entities.ts'
import { ProviderError } from './errors.ts'
import { resolveTarget, shortcodeFromPk } from './resolve.ts'
import { CaptureStrategy } from './strategy.ts'
import { sessionFixture } from './test-fixtures.ts'

const user = {
  pk: '77',
  username: 'fixture.name',
  full_name: 'Fixture',
  biography: 'Bio',
  is_private: false,
  follower_count: 4,
  profile_pic_url: 'https://cdn.test/avatar.jpg',
}
const photo = (id = '2'): Node => ({
  pk: id,
  code: shortcodeFromPk(id),
  media_type: 1,
  user,
  taken_at: 1780000000,
  caption: { text: 'Caption' },
  image_versions2: {
    candidates: [
      { url: 'https://cdn.test/small.jpg', width: 100, height: 100 },
      { url: 'https://cdn.test/original.jpg', width: 1080, height: 1080 },
    ],
  },
})
const json = (data: unknown, code = 200) =>
  Response.json(data, {
    status: code,
    headers: { 'content-type': 'application/json' },
  })
function request(
  kind = 'post',
  providerId = 'instagram-session',
  extra: Partial<FetchRequest> = {},
) {
  const target = resolveTarget(
    kind === 'post'
      ? 'https://www.instagram.com/p/C/'
      : 'https://www.instagram.com/fixture.name/',
  )
  return FetchRequest.fromPartial({
    ...target,
    providerId,
    connectionId: 'one',
    accessScope: 'connection:one',
    ...extra,
  })
}
const signal = () => new AbortController().signal
/** The pinned posts a profile result records, if it could tell. */
const pinnedOf = (result: FetchResponse) =>
  JSON.parse(Buffer.from(result.graph!.entities[0]!.dataJson).toString())
    .metadata.pinned_posts
const rejectsCode = (promise: Promise<unknown>, code: status) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof ProviderError && error.code === code,
  )

test('normalizes post variants and dotted profiles; rejects other endpoints', () => {
  for (const host of ['instagram.com', 'www.instagram.com', 'm.instagram.com'])
    for (const path of ['p', 'reel', 'tv']) {
      const target = resolveTarget(
        `http://${host}/${path}/C/?igsh=fixture#fragment`,
      )
      assert.equal(target.externalId, '2')
      assert.equal(target.url, 'https://www.instagram.com/p/C/')
    }
  assert.equal(
    resolveTarget('https://instagram.com/Fixture.Name/').externalId,
    'handle:fixture.name',
  )
  for (const url of [
    'https://instagram.com/stories/fixture/123/',
    'https://instagram.com/explore/',
    'https://instagram.com.evil.test/p/C/',
    'https://user@instagram.com/p/C/',
    'https://instagram.com:9090/p/C/',
    'https://instagram.com/a..b/',
    'https://instagram.com/p/C/c/123/',
  ])
    assert.throws(() => resolveTarget(url))
})

test('imports only the allowed browser cookies, including encoded session ids', () => {
  const credential = prepareCredential(
    Buffer.from(
      Buffer.from(
        'sessionid=77%3Afixture%3Atoken; csrftoken=csrf; ds_user_id=77; mid=mid; ig_did=device; ignored=secret',
      ).toString('base64'),
    ),
  )
  assert.deepEqual(decodeCredential(credential), {
    sessionId: '77%3Afixture%3Atoken',
    csrfToken: 'csrf',
    userId: '77',
    mid: 'mid',
    deviceId: 'device',
  })
  for (const value of [
    'sessionid=x; sessionid=y',
    'csrftoken=csrf',
    'sessionid=x\r\nCookie: bad',
    'sessionid=x; ds_user_id=abc',
  ])
    assert.throws(() =>
      prepareCredential(Buffer.from(Buffer.from(value).toString('base64'))),
    )
  assert.throws(() => prepareCredential(Buffer.from('not base64')))
})

test('keeps mixed carousel order, best renditions, and only upstream statistics', () => {
  const node = {
    ...photo(),
    media_type: 8,
    carousel_media: [
      photo('3'),
      {
        pk: '4',
        media_type: 2,
        video_versions: [
          {
            url: 'https://cdn.test/low.mp4',
            width: 360,
            height: 360,
            type: 103,
          },
          {
            url: 'https://cdn.test/high.mp4',
            width: 1080,
            height: 1080,
            bandwidth: 100,
            type: 103,
          },
          {
            url: 'https://cdn.test/best.mp4',
            width: 1080,
            height: 1080,
            bandwidth: 200,
            type: 101,
          },
        ],
      },
      { pk: '5', media_type: 1 },
    ],
  }
  const result = postResult(node, '2', Visibility.VISIBILITY_PRIVATE)
  assert.deepEqual(
    result.resources
      .filter((resource) => !resource.purpose)
      .map((resource) => resource.url),
    ['https://cdn.test/original.jpg', 'https://cdn.test/best.mp4'],
  )
  assert.equal(result.incomplete, true)
  assert.match(result.resources[0]!.immutableKey, /1080x1080/)
  assert.match(result.resources[1]!.immutableKey, /1080x1080:200$/)
  const data = JSON.parse(
    Buffer.from(result.graph!.entities[0]!.dataJson).toString(),
  )
  assert.equal(data.likes, undefined)
  assert.equal(data.replies, undefined)
  assert.equal(data.published_at, new Date(1780000000000).toISOString())
  const empty = postResult(
    { ...photo(), caption: null, taken_at: undefined, like_count: 0 },
    '2',
    Visibility.VISIBILITY_PRIVATE,
  )
  assert.equal(empty.text, '')
  assert.equal(empty.publishedAt, '')
  assert.equal(
    JSON.parse(Buffer.from(empty.graph!.entities[0]!.dataJson).toString())
      .likes,
    0,
  )
})

const session = { sessionId: 'session' }

test('missing credentials fail before any upstream request, including deferred execution', async () => {
  let calls = 0
  const strategy = new CaptureStrategy(async () => {
    calls++
    return json({})
  })
  await rejectsCode(
    strategy.fetch(request(), signal()),
    status.FAILED_PRECONDITION,
  )
  await assert.rejects(
    strategy.fetch(
      request('post', 'instagram-session', { credentialDeferred: true }),
      signal(),
    ),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.metadata.get('credential-required')[0] === '1',
  )
  assert.equal(calls, 0)
})

test('account captures keep public-profile content and raw responses private', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.ok(String(input).startsWith('https://www.instagram.com/'))
    assert.equal(new Headers(init?.headers).get('cookie'), 'sessionid=session')
    return json(String(input).includes('/p/') ? { items: [photo()] } : { user })
  }
  const result = await new CaptureStrategy(sessionFixture(fetcher)).fetch(
    request(),
    signal(),
    session,
  )
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE)
  assert.equal(result.textSource, 'instagram-session')
  assert.equal(result.text, 'Caption')
  assert.equal(result.sourceResponses.length, 2)
  const original = JSON.parse(
    Buffer.from(result.sourceResponses[0]!.body).toString(),
  )
  assert.equal(original.encoding, 'base64')
  assert.equal(original.content_type, 'text/html')
  assert.match(Buffer.from(original.body, 'base64').toString(), /Caption/)
  assert.ok(
    result.sourceResponses.every(
      (source) => source.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
  )
  assert.equal(result.graph!.relations[0]!.type, 'authored_by')
})

test('concurrent captures use only their own account, including author metadata', async () => {
  const strategy = new CaptureStrategy(
    sessionFixture(async (input, init) => {
      const cookie = new Headers(init?.headers).get('cookie')!
      assert.ok(cookie === 'sessionid=first' || cookie === 'sessionid=second')
      await new Promise((resolve) =>
        setTimeout(resolve, cookie.includes('first') ? 10 : 1),
      )
      return json(
        String(input).includes('/p/')
          ? { items: [{ ...photo(), caption: { text: cookie } }] }
          : { user: { ...user, full_name: cookie } },
      )
    }),
  )
  const [first, second] = await Promise.all([
    strategy.fetch(request(), signal(), { sessionId: 'first' }),
    strategy.fetch(
      request('post', 'instagram-session', {
        connectionId: 'two',
        accessScope: 'connection:two',
      }),
      signal(),
      { sessionId: 'second' },
    ),
  ])
  assert.equal(first.text, 'sessionid=first')
  assert.equal(second.text, 'sessionid=second')
  for (const [result, own, foreign] of [
    [first, 'first', 'second'],
    [second, 'second', 'first'],
  ] as const) {
    assert.ok(
      result.sourceResponses.every(
        (source) => source.visibility === Visibility.VISIBILITY_PRIVATE,
      ),
    )
    const raw = result.sourceResponses
      .map((source) => Buffer.from(source.body).toString())
      .join('')
    assert.ok(raw.includes(own))
    assert.ok(!raw.includes(foreign))
  }
})

test('authenticated profiles keep complete pages, retry cursors and renamed stable IDs', async () => {
  let fail = true
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('cookie'), 'sessionid=session')
    if (
      new URLSearchParams(init?.body as string).get(
        'fb_api_req_friendly_name',
      ) === 'PolarisProfilePageContentQuery'
    )
      return json({ user: { ...user, username: 'renamed.name' } })
    if (
      JSON.parse(
        new URLSearchParams(init?.body as string).get('variables') || '{}',
      ).after
    )
      return fail
        ? json({}, 503)
        : json({ items: [photo('4'), photo('5')], more_available: false })
    return json({
      items: [photo('2'), photo('3')],
      more_available: true,
      next_max_id: 'page-two',
    })
  }
  const strategy = new CaptureStrategy(sessionFixture(fetcher))
  const result = await strategy.fetch(
    request('profile', 'instagram-session', { pageSize: 3 }),
    signal(),
    session,
  )
  assert.equal(result.canonicalTarget?.externalId, '77')
  assert.equal(
    result.canonicalTarget?.url,
    'https://www.instagram.com/renamed.name/',
  )
  assert.equal(result.relatedTargets.length, 2)
  assert.equal(result.incomplete, true)
  assert.deepEqual(JSON.parse(result.nextPageCursor), {
    user: '77',
    mode: 'session',
    cursor: 'page-two',
  })
  assert.equal(result.maxBatchSize, 1000)
  fail = false
  const next = await strategy.fetch(
    request('profile', 'instagram-session', {
      externalId: '77',
      pageSize: 1,
      pageCursor: result.nextPageCursor,
    }),
    signal(),
    session,
  )
  assert.equal(next.relatedTargets.length, 2)
  assert.equal(next.nextPageCursor, '')
  // The first page leads with the pinned posts, so none is pinned here; a
  // later page cannot tell.
  assert.deepEqual(pinnedOf(result), [])
  assert.equal(pinnedOf(next), undefined)
  for (const [id, mode] of [
    ['other', 'session'],
    ['77', 'public'],
  ])
    await rejectsCode(
      strategy.fetch(
        request('profile', 'instagram-session', {
          externalId: '77',
          pageCursor: JSON.stringify({ user: id, mode, cursor: 'page-two' }),
        }),
        signal(),
        session,
      ),
      status.FAILED_PRECONDITION,
    )
})

test('a profile timeline stops past the date cutoff, pinned posts aside', async () => {
  const day = 86_400
  const now = 1_780_000_000
  const post = (id: string, age: number, extra: Node = {}) => ({
    ...photo(id),
    taken_at: now - age * day,
    ...extra,
  })
  const pages: Record<string, Node> = {
    '': {
      items: [post('2', 300, { timeline_pinned_user_ids: ['77'] })],
      next_max_id: 'p2',
    },
    p2: { items: [post('3', 1), post('4', 30)], next_max_id: 'p3' },
    p3: { items: [post('5', 40)], next_max_id: 'p4' },
  }
  const cursors: string[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    const body = new URLSearchParams(init?.body as string)
    if (
      body.get('fb_api_req_friendly_name') === 'PolarisProfilePageContentQuery'
    )
      return json({ user })
    const after = JSON.parse(body.get('variables') || '{}').after ?? ''
    cursors.push(after)
    return json({ ...pages[after], more_available: true })
  }
  const strategy = new CaptureStrategy(sessionFixture(fetcher))
  const result = await strategy.fetch(
    request('profile', 'instagram-session', {
      since: new Date((now - 7 * day) * 1000).toISOString(),
    }),
    signal(),
    session,
  )
  // The pinned post is old, the second page ends past the cutoff.
  assert.deepEqual(cursors, ['', 'p2'])
  assert.equal(JSON.parse(result.nextPageCursor).cursor, 'p3')
  const pinned = result.relatedTargets.filter((t) => t.pinned)
  assert.equal(pinned.length, 1)
  assert.equal(
    result.relatedTargets.at(-1)?.listedAt,
    new Date((now - 30 * day) * 1000).toISOString(),
  )
  // A first page of pinned posts only may hold just some of them.
  assert.equal(pinnedOf(result), undefined)
})

test('the profile records the pinned posts its first page leads with', async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const body = new URLSearchParams(init?.body as string)
    if (
      body.get('fb_api_req_friendly_name') === 'PolarisProfilePageContentQuery'
    )
      return json({ user })
    return json({
      items: [
        { ...photo('3'), timeline_pinned_user_ids: [77] },
        { ...photo('2'), timeline_pinned_user_ids: ['77'] },
        photo('4'),
      ],
      more_available: true,
      next_max_id: 'p2',
    })
  }
  const strategy = new CaptureStrategy(sessionFixture(fetcher))
  const result = await strategy.fetch(
    request('profile', 'instagram-session', { pageSize: 3 }),
    signal(),
    session,
  )
  assert.deepEqual(pinnedOf(result), ['3', '2'])
  // An automatic refresh reads no timeline, so it cannot tell.
  const refresh = await strategy.fetch(
    request('profile', 'instagram-session', { automatic: true }),
    signal(),
    session,
  )
  assert.equal(pinnedOf(refresh), undefined)
})

test('private profiles use their selected account for timelines and retain partial progress', async () => {
  const strategy = new CaptureStrategy(
    sessionFixture(async (input, init) => {
      assert.equal(
        new Headers(init?.headers).get('cookie'),
        'sessionid=session',
      )
      if (
        new URLSearchParams(init?.body as string).get(
          'fb_api_req_friendly_name',
        ) === 'PolarisProfilePageContentQuery'
      )
        return json({ user: { ...user, is_private: true } })
      if (
        JSON.parse(
          new URLSearchParams(init?.body as string).get('variables') || '{}',
        ).after
      )
        return json({ status: 'fail', message: 'login_required' })
      return json({
        items: [photo()],
        more_available: true,
        next_max_id: 'second',
      })
    }),
  )
  const result = await strategy.fetch(request('profile'), signal(), session)
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE)
  assert.equal(result.relatedTargets.length, 1)
  assert.equal(result.incomplete, true)
  assert.equal(JSON.parse(result.nextPageCursor).cursor, 'second')
  assert.match(result.warnings[0]!, /登录已失效/)
})

test('classifies expired sessions, verification, limits, redirects and identity mismatch without anonymous retries', async () => {
  for (const [data, code] of [
    [{ status: 'fail', message: 'login_required' }, status.UNAUTHENTICATED],
    [
      { status: 'fail', message: 'challenge_required' },
      status.PERMISSION_DENIED,
    ],
  ] as const)
    await rejectsCode(
      new InstagramClient(signal(), session, async () => json(data)).post('2'),
      code,
    )
  await assert.rejects(
    new InstagramClient(
      signal(),
      session,
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    ).post('2'),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.metadata.get('retry-after')[0] === '7',
  )
  await rejectsCode(
    new InstagramClient(
      signal(),
      session,
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.test/' },
        }),
    ).post('2'),
    status.UNAUTHENTICATED,
  )
  await rejectsCode(
    new InstagramClient(
      signal(),
      { ...session, userId: '78' },
      async () =>
        new Response(
          `<script type="application/json" data-sjs>${JSON.stringify({
            define: [['PolarisViewer', [], { data: user }, 0]],
          })}</script>`,
        ),
    ).checkConnection(),
    status.UNAUTHENTICATED,
  )
  await rejectsCode(
    new InstagramClient(
      signal(),
      session,
      sessionFixture(async () => json({ user: { ...user, pk: '88' } })),
    ).profile('77'),
    status.UNAVAILABLE,
  )
  let calls = 0
  await rejectsCode(
    new CaptureStrategy(async () => {
      calls++
      return json({}, 401)
    }).fetch(request(), signal(), session),
    status.UNAUTHENTICATED,
  )
  assert.equal(calls, 1)
})

test('cancellation propagates to the authenticated upstream', async () => {
  const controller = new AbortController()
  const fetcher: typeof fetch = async (_input, options) => {
    assert.equal(options?.signal, controller.signal)
    controller.abort()
    throw new Error('aborted')
  }
  await rejectsCode(
    new CaptureStrategy(sessionFixture(fetcher)).fetch(
      request(),
      controller.signal,
      session,
    ),
    status.DEADLINE_EXCEEDED,
  )
})

test('single video keeps its best encode and a missing media URL stays incomplete', () => {
  const node = {
    ...photo(),
    media_type: 2,
    video_versions: [
      {
        url: 'https://cdn.test/video-small.mp4',
        width: 360,
        height: 640,
        bandwidth: 100,
      },
      {
        url: 'https://cdn.test/video-original.mp4',
        width: 1080,
        height: 1920,
        bandwidth: 400,
      },
    ],
  }
  const video = postResult(node, '2', Visibility.VISIBILITY_PRIVATE)
  assert.equal(video.resources[0]!.url, 'https://cdn.test/video-original.mp4')
  assert.equal(video.resources[0]!.kind, 'video')
  const missing = postResult(
    { ...photo(), image_versions2: undefined },
    '2',
    Visibility.VISIBILITY_PRIVATE,
  )
  assert.equal(missing.incomplete, true)
  assert.equal(missing.resources.filter((r) => !r.purpose).length, 0)
})

test('listed posts reuse only their own connection and session; explicit refreshes still fetch', async () => {
  let calls = 0
  const fetcher = sessionFixture(async (input, init = {}) => {
    calls++
    const cookie = new Headers(init.headers).get('cookie')!
    const name = new URLSearchParams(init.body as string).get(
      'fb_api_req_friendly_name',
    )
    if (name === 'PolarisProfilePageContentQuery') return json({ user })
    return json({
      items: [{ ...photo(), caption: { text: cookie } }],
      more_available: false,
    })
  })
  const strategy = new CaptureStrategy(fetcher)
  await strategy.fetch(request('profile'), signal(), { sessionId: 'first' })
  const before = calls
  const automatic = request('post', 'instagram-session', { automatic: true })
  const saved = await strategy.fetch(automatic, signal(), {
    sessionId: 'first',
  })
  assert.equal(calls, before)
  assert.equal(saved.text, 'sessionid=first')
  const aborted = new AbortController()
  aborted.abort()
  await rejectsCode(
    strategy.fetch(automatic, aborted.signal, { sessionId: 'first' }),
    status.DEADLINE_EXCEEDED,
  )
  assert.equal(calls, before)
  assert.ok(
    saved.sourceResponses.every(
      (source) => source.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
  )
  saved.text = 'changed externally'
  assert.equal(
    (await strategy.fetch(automatic, signal(), { sessionId: 'first' })).text,
    'sessionid=first',
  )
  for (const [req, credential] of [
    [request(), { sessionId: 'first' }],
    [
      request('post', 'instagram-session', {
        automatic: true,
        connectionId: 'two',
        accessScope: 'connection:two',
      }),
      { sessionId: 'first' },
    ],
    [automatic, { sessionId: 'second' }],
  ] as const) {
    const start = calls
    const result = await strategy.fetch(req, signal(), credential)
    assert.ok(calls > start)
    assert.equal(result.text, `sessionid=${credential.sessionId}`)
  }
})
