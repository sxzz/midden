import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount } from '#accounts/accounts.ts'
import { newId } from '#db/id.ts'
import {
  apiTokens,
  catalog,
  entities,
  followEdges,
  relationFetches,
} from '#db/schema.ts'
import { createShare } from '#library/shares.ts'
import {
  ACCOUNTS,
  agentFixture,
  LONG_TEXT,
  profile,
  type AgentFixture,
} from '#testing/agent.ts'
import { capture } from '#testing/library.ts'
import { revokeToken, rollToken } from '#tokens/tokens.ts'

let fixture: AgentFixture | undefined
afterEach(async () => {
  await fixture?.ctx.queue.stop()
  fixture = undefined
})

async function setup() {
  fixture = await agentFixture()
  return fixture
}

const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe('tokens', () => {
  test('a request without a valid token is refused and says why', async () => {
    const f = await setup()
    const anonymous = await f.app.request('/agent/v1/whoami')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual(
      expect.objectContaining({ error: 'token_invalid' }),
    )
    expect((await f.call('/whoami', { token: 'mdn_rw_nope' })).json.error).toBe(
      'token_invalid',
    )

    const token = f.token('ro', new Date(Date.now() + 60_000))
    expect((await f.call('/whoami', { token })).status).toBe(200)
    f.ctx.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run()
    const expired = await f.call('/whoami', { token })
    expect(expired.status).toBe(401)
    expect(expired.json).toEqual({
      error: 'token_expired',
      message: expect.stringContaining('ask the owner'),
    })
  })

  test('a rolled secret stops at once; a revoked token is gone', async () => {
    const f = await setup()
    const token = f.token('ro')
    const { id } = f.ctx.db.select().from(apiTokens).all().at(-1)!
    const rolled = rollToken(f.ctx.db, id).secret
    expect((await f.call('/whoami', { token })).json.error).toBe(
      'token_invalid',
    )
    expect((await f.call('/whoami', { token: rolled })).status).toBe(200)
    revokeToken(f.ctx.db, id)
    expect((await f.call('/whoami', { token: rolled })).status).toBe(401)
  })

  test('whoami names the token and counts today', async () => {
    const f = await setup()
    const token = f.token('ro')
    await f.call('/posts', { token })
    await f.call('/tags', { token })
    const { json } = await f.call('/whoami', { token })
    expect(json).toEqual({
      token: {
        id: expect.any(String),
        label: 'ro',
        permission: 'ro',
        created_at: expect.any(String),
        expires_at: null,
      },
      usage: { today: 2 },
      limits: {
        in_flight: 2,
        page_size_max: 50,
        batch_max: 100,
        query_timeout_ms: 5000,
      },
    })
    // Written, it still counts the same, and by endpoint.
    f.usage.flush()
    expect((await f.call('/whoami', { token })).json.usage.today).toBe(3)
    expect(f.usage.endpoints(f.ctx.db, json.token.id)).toEqual([
      { endpoint: 'GET /agent/v1/whoami', count: 2 },
      { endpoint: 'GET /agent/v1/posts', count: 1 },
      { endpoint: 'GET /agent/v1/tags', count: 1 },
    ])
  })

  test('a read-only token cannot write', async () => {
    const f = await setup()
    const token = f.token('ro')
    const response = await f.call(`/posts/${f.ids.p1}/note`, {
      token,
      method: 'PUT',
      body: { note: 'x' },
    })
    expect(response.status).toBe(403)
    expect(response.json.error).toBe('forbidden')
    expect(
      (await f.call('/posts/batch', { token, body: { ids: [f.ids.p1] } }))
        .status,
    ).toBe(200)
  })
})

describe('posts and accounts', () => {
  test('a search pages with a cursor bound to its query', async () => {
    const f = await setup()
    const first = await f.call('/posts?size=2')
    expect(first.status).toBe(200)
    expect(first.json.applied).toEqual({ sort: 'updated', order: 'desc' })
    expect(first.json.total).toBe(4)
    expect(first.json.has_more).toBe(true)
    expect(ids(first.json.items)).toEqual([f.ids.p4, f.ids.p3])
    const second = await f.call(
      `/posts?size=2&cursor=${first.json.next_cursor}`,
    )
    expect(ids(second.json.items)).toEqual([f.ids.p2, f.ids.p1])
    expect(second.json).not.toHaveProperty('total')
    expect(second.json.has_more).toBe(false)
    expect(second.json).not.toHaveProperty('next_cursor')

    // Another size or view is the same query; another filter is not.
    const view = await f.call(
      `/posts?size=3&view=full&cursor=${first.json.next_cursor}`,
    )
    expect(view.status).toBe(200)
    const other = await f.call(
      `/posts?size=2&q=cat&cursor=${first.json.next_cursor}`,
    )
    expect(other.status).toBe(400)
    expect(other.json.error).toBe('cursor_mismatch')
    const sorted = await f.call(
      `/posts?size=2&order=asc&cursor=${first.json.next_cursor}`,
    )
    expect(sorted.json.error).toBe('cursor_mismatch')
    expect((await f.call('/posts?cursor=nonsense')).json.error).toBe(
      'invalid_request',
    )
  })

  test('applied is the canonical filter', async () => {
    const f = await setup()
    const { json } = await f.call(
      '/posts?q=%20cat%20&author=fake:@alice&media_type=text,image&media_type=image&platform=fake&sensitive=false',
    )
    expect(json.applied).toEqual({
      q: 'cat',
      author: ['fake/fake.profile/7'],
      media_type: ['image', 'text'],
      sensitive: false,
      sort: 'relevance',
    })
    // The quote of a cat post mentions one too, less closely.
    expect(ids(json.items)).toEqual([f.ids.p1, f.ids.p2])
  })

  test('parameters are checked with messages to act on', async () => {
    const f = await setup()
    const cases: [string, string][] = [
      ['/posts?colour=red', 'Unknown parameter: colour'],
      ['/posts?size=51', 'size must be'],
      ['/posts?sort=followers', 'sort must be one of'],
      ['/posts?author=@alice', 'without a platform'],
      ['/posts?tag=nope', 'Unknown tag: nope'],
      ['/posts?rel=following', 'rel_of and rel come together'],
      ['/accounts?post_type=quote', 'Unknown parameter: post_type'],
      ['/posts?q=a&q=b', 'q is given more than once'],
    ]
    for (const [path, message] of cases) {
      const { status, json } = await f.call(path)
      expect({ path, status, error: json.error }).toEqual({
        path,
        status: 400,
        error: 'invalid_request',
      })
      expect(json.message).toContain(message)
    }
    // An author the archive has no account for selects nothing, as
    // from: does; with one it has, that one's posts.
    const unknown = await f.call('/posts?author=fake:@nobody')
    expect(unknown.status).toBe(200)
    expect(unknown.json).toEqual({
      applied: { author: ['fake:@nobody'], sort: 'updated', order: 'desc' },
      items: [],
      total: 0,
      has_more: false,
    })
    const either = await f.call('/posts?author=fake:@nobody,fake:@bob')
    expect(either.json.total).toBe(2)
    expect(either.json.applied.author).toEqual([
      'fake/fake.profile/8',
      'fake:@nobody',
    ])
    const query = await f.call(`/posts?q=${encodeURIComponent('from:@nobody')}`)
    expect(query.json).toMatchObject({ items: [], total: 0 })
  })

  test('compact cuts and counts; full has everything', async () => {
    const f = await setup()
    const [compact] = (await f.call('/posts?q=Walking')).json.items
    expect(compact.text).toHaveLength(281)
    expect(compact.text.endsWith('…')).toBe(true)
    expect(compact.text_truncated).toBe(true)
    expect(compact.media).toEqual({ images: 1, videos: 0 })
    expect(compact).not.toHaveProperty('tags')

    const full = (await f.call(`/posts/${f.ids.p4}`)).json
    expect(full.text).toBe(LONG_TEXT)
    expect(full).not.toHaveProperty('text_truncated')
    expect(full.media).toEqual([
      {
        kind: 'image',
        state: 'ready',
        url: expect.stringMatching(/^http:\/\/localhost\/media\/[\da-f]{64}\?/),
        alt_text: 'a dog in a park',
        sensitive: false,
        mime: 'image/jpeg',
      },
    ])
    expect(full.tags).toEqual([])
    expect(full.author).toEqual({
      id: f.ids['8'],
      key: 'fake/fake.profile/8',
      handle: 'bob',
      name: 'Bob',
    })
  })

  test('a quoted post comes with what the archive has of it', async () => {
    const f = await setup()
    const post = (await f.call(`/posts/${f.ids.p2}`)).json
    expect(post.quoted).toEqual({
      id: f.ids.p1,
      platform_id: 'p1',
      author: {
        id: f.ids['7'],
        key: 'fake/fake.profile/7',
        handle: 'alice',
        name: 'Alice',
      },
      text: 'A cat on the mat',
      lang: 'en',
    })
  })

  test('accounts search and sort by followers', async () => {
    const f = await setup()
    const { json } = await f.call('/accounts?sort=followers&order=asc')
    expect(json.applied).toEqual({ sort: 'followers', order: 'asc' })
    expect(ids(json.items)).toEqual([f.ids['8'], f.ids['7']])
    expect(json.items[1]).toEqual({
      id: f.ids['7'],
      kind: 'account',
      platform: 'fake',
      url: 'https://fake.test/u/7',
      key: 'fake/fake.profile/7',
      platform_id: '7',
      handle: 'alice',
      name: 'Alice',
      bio: 'Alice draws cats.',
      lang: 'en',
      followers: 120,
      following: 5,
      saved_at: expect.any(String),
      updated_at: expect.any(String),
    })
  })

  test('one post or account, or not_found', async () => {
    const f = await setup()
    expect((await f.call(`/posts/${f.ids.p1}?view=compact`)).json.id).toBe(
      f.ids.p1,
    )
    // An account is not a post, nor the other way round.
    const wrong = await f.call(`/posts/${f.ids['7']}`)
    expect(wrong.status).toBe(404)
    expect(wrong.json.error).toBe('not_found')
    expect((await f.call(`/accounts/${f.ids.p1}`)).status).toBe(404)
    expect((await f.call('/posts/not-an-id')).status).toBe(400)
    for (const ref of [
      f.ids['7'],
      encodeURIComponent('fake/fake.profile/7'),
      'fake:@alice',
      'fake:@ALICE',
      '@alice?platform=fake',
    ])
      expect((await f.call(`/accounts/${ref}`)).json.id).toBe(f.ids['7'])
    expect((await f.call('/accounts/@alice')).status).toBe(400)
    expect((await f.call('/accounts/fake:@carol')).status).toBe(404)
  })

  test('batches list what they did not find', async () => {
    const f = await setup()
    const gone = '01234567-89ab-cdef-0123-456789abcdef'
    const posts = await f.call('/posts/batch', {
      body: { ids: [f.ids.p3, gone, f.ids['7'], f.ids.p1], view: 'compact' },
    })
    expect(ids(posts.json.items)).toEqual([f.ids.p3, f.ids.p1])
    expect(posts.json.missing).toEqual([gone, f.ids['7']])
    const accounts = await f.call('/accounts/batch', {
      body: { ids: ['@bob', 'fake:@alice', '@carol'], platform: 'fake' },
    })
    expect(ids(accounts.json.items)).toEqual([f.ids['8'], f.ids['7']])
    expect(accounts.json.missing).toEqual(['@carol'])
    expect(
      (
        await f.call('/posts/batch', {
          body: { ids: Array.from({ length: 101 }).fill(gone) },
        })
      ).json.error,
    ).toBe('invalid_request')
  })

  test('context: what quotes it and what relates to it', async () => {
    const f = await setup()
    const { json } = await f.call(`/posts/${f.ids.p1}/context`)
    expect(json.post.id).toBe(f.ids.p1)
    expect(ids(json.quoted_by)).toEqual([f.ids.p2])
    expect(json.reposted_by).toEqual([])
    expect(
      json.related.map((r: { relation: string[]; item: { id: string } }) => [
        r.relation,
        r.item.id,
      ]),
    ).toEqual([[['authored_by'], f.ids['7']]])
    expect(json.related_more).toBe(false)
  })

  test('metrics are each capture’s counts', async () => {
    const f = await setup()
    expect((await f.call(`/accounts/fake:@alice/metrics`)).json).toEqual({
      id: f.ids['7'],
      entity_type: 'fake.profile',
      points: [
        { observed_at: expect.any(String), followers: 120, following: 5 },
      ],
    })
    expect((await f.call(`/posts/${f.ids.p3}/metrics`)).json.points).toEqual([
      { observed_at: expect.any(String), likes: 9 },
    ])
  })
})

describe('query language', () => {
  test('q takes the language, echoes it canonically, and ANDs with the rest', async () => {
    const f = await setup()
    const q = (query: string, rest = '') =>
      f.call(`/posts?q=${encodeURIComponent(query)}${rest}`)
    const either = await q('dog  OR   cat')
    expect(either.status).toBe(200)
    expect(either.json.parsed).toBe('dog OR cat')
    expect(either.json.applied.q).toBe('dog OR cat')
    expect(ids(either.json.items).toSorted()).toEqual(
      [f.ids.p1, f.ids.p2, f.ids.p3, f.ids.p4].toSorted(),
    )
    const alice = await q('-from:@bob since:2020-01-01')
    expect(ids(alice.json.items).toSorted()).toEqual(
      [f.ids.p1, f.ids.p2].toSorted(),
    )
    expect(alice.json.total).toBe(2)
    // With the structured parameters: both hold.
    const both = await q('dog OR cat', '&author=fake:@bob')
    expect(ids(both.json.items).toSorted()).toEqual(
      [f.ids.p3, f.ids.p4].toSorted(),
    )
    expect(both.json.total).toBe(2)
    const accounts = await f.call(
      `/accounts?q=${encodeURIComponent('cats OR dogs')}`,
    )
    expect(ids(accounts.json.items).toSorted()).toEqual(
      [f.ids['7'], f.ids['8']].toSorted(),
    )
  })

  test('a cursor is bound to the canonical query', async () => {
    const f = await setup()
    const first = await f.call(
      `/posts?size=1&q=${encodeURIComponent('dog OR cat')}`,
    )
    expect(first.json.has_more).toBe(true)
    const same = await f.call(
      `/posts?size=1&q=${encodeURIComponent('dog   OR cat')}&cursor=${first.json.next_cursor}`,
    )
    expect(same.status).toBe(200)
    const other = await f.call(
      `/posts?size=1&q=${encodeURIComponent('cat OR dog')}&cursor=${first.json.next_cursor}`,
    )
    expect(other.json.error).toBe('cursor_mismatch')
  })

  test('a query that cannot run is query_invalid, with where', async () => {
    const f = await setup()
    const cases: [string, number, string][] = [
      ['cat (dog', 4, 'never closed'],
      ['cat since:soon', 4, 'YYYY-MM-DD'],
      ['-#ad', 0, 'only exclusions'],
      ['tag:nope', 0, 'Unknown tag nope'],
      ['folder:nope', 0, 'No folder nope'],
    ]
    for (const [query, position, message] of cases) {
      const { status, json } = await f.call(
        `/posts?q=${encodeURIComponent(query)}`,
      )
      expect({
        query,
        status,
        error: json.error,
        position: json.position,
      }).toEqual({
        query,
        status: 400,
        error: 'query_invalid',
        position,
      })
      expect(json.message).toContain(message)
    }
  })
})

describe('languages', () => {
  test('posts, the posts they quote and accounts carry the detected language', async () => {
    const f = await setup()
    const quoting = await f.call(`/posts/${f.ids.p2}`)
    expect(quoting.json.lang).toBe('en')
    expect(quoting.json.quoted).toMatchObject({ id: f.ids.p1, lang: 'en' })
    const account = await f.call(`/accounts/${f.ids['7']}`)
    expect(account.json).toMatchObject({ bio: 'Alice draws cats.', lang: 'en' })
    const langs = await f.call('/aggregate?by=lang')
    expect(langs.json.buckets.map((b: { key: string }) => b.key)).toContain(
      'en',
    )
  })
})

describe('aggregate', () => {
  test('buckets with counts, first and last, and samples', async () => {
    const f = await setup()
    const { status, json } = await f.call(
      `/aggregate?by=author&q=${encodeURIComponent('type:post')}`,
    )
    expect(status).toBe(200)
    expect(json.parsed).toBe('type:post')
    expect(json.total).toBe(4)
    expect(json.truncated).toBe(false)
    expect(json.buckets).toEqual([
      {
        key: 'fake/fake.profile/7',
        handle: 'alice',
        name: 'Alice',
        count: 2,
        first: expect.any(String),
        last: expect.any(String),
        samples: expect.arrayContaining([f.ids.p1, f.ids.p2]),
      },
      {
        key: 'fake/fake.profile/8',
        handle: 'bob',
        name: 'Bob',
        count: 2,
        first: expect.any(String),
        last: expect.any(String),
        samples: expect.arrayContaining([f.ids.p3, f.ids.p4]),
      },
    ])
    // Without type:, posts only, and parsed says so.
    const types = await f.call('/aggregate?by=type&limit=1')
    expect(types.json.parsed).toBe('type:post')
    expect(types.json.total).toBe(4)
    expect(types.json.buckets).toHaveLength(1)
    expect(types.json.buckets[0]).toMatchObject({ key: 'original', count: 3 })
    expect(types.json.truncated).toBe(true)
    const implied = await f.call(
      `/aggregate?by=type&q=${encodeURIComponent('dog OR cat')}`,
    )
    expect(implied.json.parsed).toBe('type:post (dog OR cat)')
    expect(implied.json.total).toBe(4)
    const accounts = await f.call(
      `/aggregate?by=type&q=${encodeURIComponent('type:profile')}`,
    )
    expect(accounts.json).toMatchObject({
      parsed: 'type:profile',
      total: 2,
      buckets: [{ key: 'profile', count: 2 }],
    })
    const both = await f.call(
      `/aggregate?by=type&q=${encodeURIComponent('type:post OR type:profile')}`,
    )
    expect(both.json.total).toBe(6)
    const months = await f.call('/aggregate?by=month&tz=Asia/Tokyo')
    expect(months.json.tz).toBe('Asia/Tokyo')
    expect(months.json.buckets[0].key).toMatch(/^\d{4}-\d{2}$/)
    expect(
      months.json.buckets.reduce(
        (n: number, b: { count: number }) => n + b.count,
        0,
      ),
    ).toBe(4)
    for (const [path, error] of [
      ['/aggregate', 'invalid_request'],
      ['/aggregate?by=colour', 'invalid_request'],
      ['/aggregate?by=day&tz=Mars/Base', 'invalid_request'],
      ['/aggregate?by=day&limit=0', 'invalid_request'],
      [`/aggregate?by=day&q=${encodeURIComponent('a OR')}`, 'query_invalid'],
    ])
      expect((await f.call(path)).json.error, path).toBe(error)
  })
})

describe('around an account', () => {
  /** Alice follows Bob, and stopped following Carol (not saved). */
  function follows(f: AgentFixture) {
    const entity = (id: string) =>
      f.ctx.db.select().from(catalog).where(eq(catalog.collectionId, id)).get()!
        .rootEntityId!
    const alice = entity(f.ids['7'])
    const bob = entity(f.ids['8'])
    const carol = newId()
    f.ctx.db
      .insert(entities)
      .values({
        id: carol,
        platform: 'fake',
        kind: 'fake.profile',
        externalId: '9',
      })
      .run()
    const day = (n: number) => new Date(Date.UTC(2026, 10, n))
    f.ctx.db
      .insert(relationFetches)
      .values(
        [1, 10].map((n) => ({
          id: newId(),
          list: 'following' as const,
          entityId: alice,
          state: 'complete' as const,
          finishedAt: day(n),
        })),
      )
      .run()
    f.ctx.db
      .insert(followEdges)
      .values([
        {
          followerId: alice,
          followeeId: bob,
          firstSeenAt: day(1),
          lastSeenAt: day(10),
        },
        {
          followerId: alice,
          followeeId: carol,
          firstSeenAt: day(1),
          lastSeenAt: day(1),
          endedAt: day(10),
        },
      ])
      .run()
  }

  test('relations, with how complete the lists are', async () => {
    const f = await setup()
    follows(f)
    const { json } = await f.call(
      '/accounts/fake:@alice/relations?rel=following',
    )
    expect(json).toEqual({
      account: { id: f.ids['7'], key: 'fake/fake.profile/7', handle: 'alice' },
      rel: 'following',
      counts: { following: 1, followers: 0, mutual: 0 },
      lists: {
        following: { complete_at: '2026-11-10T00:00:00.000Z' },
        followers: {},
      },
      applied: {
        rel_of: ['fake/fake.profile/7'],
        rel: 'following',
        rel_min: 1,
        sort: 'followers',
        order: 'desc',
      },
      items: [expect.objectContaining({ id: f.ids['8'], kind: 'account' })],
      total: 1,
      has_more: false,
    })
    expect(
      (await f.call('/accounts/fake:@bob/relations?rel=followers')).json.items,
    ).toEqual([expect.objectContaining({ id: f.ids['7'] })])
    expect((await f.call('/accounts/fake:@bob/relations')).status).toBe(400)
    // The same follows select posts: Bob's, by whom Alice follows.
    const posts = await f.call(
      '/posts?rel_of=fake:@alice&rel=following&sort=published',
    )
    expect(ids(posts.json.items).toSorted()).toEqual(
      [f.ids.p3, f.ids.p4].toSorted(),
    )
  })

  test('relation changes are observations', async () => {
    const f = await setup()
    follows(f)
    const { json } = await f.call('/accounts/fake:@alice/relation-changes')
    expect(json.items).toEqual([
      {
        type: 'unfollow',
        observed_at: '2026-11-10T00:00:00.000Z',
        since: '2026-11-01T00:00:00.000Z',
        account: { key: 'fake/fake.profile/9' },
      },
    ])
    expect(json.lists.following.complete_at).toBe('2026-11-10T00:00:00.000Z')
  })

  test('history lists what changed in the profile', async () => {
    const f = await setup()
    ACCOUNTS['7']!.name = 'Alice 🎨'
    try {
      await capture(f.ctx, profile('7'))
    } finally {
      ACCOUNTS['7']!.name = 'Alice'
    }
    const { json } = await f.call(`/accounts/${f.ids['7']}/history`)
    expect(json).toEqual({
      account: { id: f.ids['7'], key: 'fake/fake.profile/7', handle: 'alice' },
      items: [
        {
          observed_at: expect.any(String),
          capture_id: expect.any(String),
          changes: [{ field: 'name', before: 'Alice', after: 'Alice 🎨' }],
        },
      ],
    })
    expect(
      (await f.call(`/accounts/${f.ids['7']}/history?limit=0`)).status,
    ).toBe(400)
  })
})

describe('writes', () => {
  test('tags and notes on posts and accounts', async () => {
    const f = await setup()
    const tagged = await f.call(`/posts/${f.ids.p1}/tags`, {
      body: { tag: 'cats' },
    })
    expect(tagged.json).toEqual({
      id: f.ids.p1,
      tags: [{ id: expect.any(String), name: 'cats' }],
      note: '',
    })
    const tag = tagged.json.tags[0]
    await f.call(`/accounts/fake:@alice/tags`, { body: { tag: tag.id } })
    await f.call(`/posts/${f.ids.p1}/note`, {
      method: 'PUT',
      body: { note: 'the first cat' },
    })
    expect((await f.call('/tags')).json.items).toEqual([
      { id: tag.id, name: 'cats', collections: 2 },
    ])
    // An account's tag covers its posts.
    const { json } = await f.call('/posts?tag=cats')
    expect(json.applied.tag).toEqual([tag])
    expect(ids(json.items).toSorted()).toEqual([f.ids.p1, f.ids.p2].toSorted())
    expect(json.items.find((i: { id: string }) => i.id === f.ids.p1)).toEqual(
      expect.objectContaining({ tags: ['cats'], note: 'the first cat' }),
    )

    expect(
      (await f.call(`/posts/${f.ids.p1}/note`, { method: 'DELETE' })).json.note,
    ).toBe('')
    await f.call(`/posts/${f.ids.p1}/tags/cats`, { method: 'DELETE' })
    await f.call(`/accounts/fake:@alice/tags/${tag.id}`, { method: 'DELETE' })
    // Nothing uses it any more.
    expect((await f.call('/tags')).json.items).toEqual([])
  })

  test('tags are renamed and merged', async () => {
    const f = await setup()
    const cats = (
      await f.call(`/posts/${f.ids.p1}/tags`, { body: { tag: 'cats' } })
    ).json.tags[0]
    const felines = (
      await f.call(`/posts/${f.ids.p2}/tags`, { body: { tag: 'felines' } })
    ).json.tags[0]
    const renamed = await f.call(`/tags/${cats.id}`, {
      method: 'PATCH',
      body: { name: 'kittens' },
    })
    expect(renamed.json).toEqual({
      tag: { id: cats.id, name: 'kittens' },
      merged: false,
      moved: 0,
    })
    const merged = await f.call('/tags/kittens/merge', {
      body: { into: 'felines' },
    })
    expect(merged.json).toEqual({ tag: felines, merged: true, moved: 1 })
    expect((await f.call('/tags')).json.items).toEqual([
      { id: felines.id, name: 'felines', collections: 2 },
    ])
    expect(
      (await f.call(`/tags/${felines.id}/merge`, { body: { into: 'felines' } }))
        .status,
    ).toBe(400)
  })

  test('folders are saved from the search’s terms and scope searches', async () => {
    const f = await setup()
    const made = await f.call('/folders', {
      body: {
        name: 'Alice',
        filter: { author: 'fake:@alice', sort: 'published' },
      },
    })
    expect(made.status).toBe(201)
    expect(made.json).toEqual({
      id: expect.any(String),
      name: 'Alice',
      filter: { author: ['fake/fake.profile/7'], sort: 'published' },
      posts: 2,
      accounts: 0,
      counted_at: expect.any(String),
      stale: false,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    })
    expect((await f.call('/folders')).json.items).toEqual([made.json])

    const scoped = await f.call(`/posts?folder=${made.json.id}&q=cat`)
    expect(ids(scoped.json.items)).toEqual([f.ids.p1, f.ids.p2])
    expect(scoped.json.applied).toEqual({
      q: 'cat',
      folder: { id: made.json.id, name: 'Alice' },
      // The folder's own order stands, within relevance tiers.
      sort: 'published',
      order: 'desc',
    })
    expect(scoped.json.total).toBe(2)
    const widening = await f.call(`/posts?folder=${made.json.id}&tag=x`)
    expect(widening.json.message).toContain('only narrow')

    const renamed = await f.call(`/folders/${made.json.id}`, {
      method: 'PATCH',
      body: { name: 'Bob', filter: { author: ['fake:@bob'] } },
    })
    expect(renamed.json.filter).toEqual({ author: ['fake/fake.profile/8'] })
    expect(renamed.json.posts).toBe(2)
    const taken = await f.call('/folders', {
      body: { name: 'Bob', filter: {} },
    })
    expect(taken.status).toBe(409)
    expect(taken.json.error).toBe('conflict')
  })

  test('captures and updates answer with where to follow them', async () => {
    const f = await setup()
    const captured = await f.call('/captures', {
      body: { url: 'https://fake.test/p/p3' },
    })
    expect(captured.status).toBe(202)
    expect(captured.json).toEqual({
      record_id: expect.any(String),
      collection_id: f.ids.p3,
      state: expect.any(String),
      status_url: `/agent/v1/updates/${captured.json.record_id}`,
    })
    await f.ctx.queue.drain()
    const status = await f.call(`/updates/${captured.json.record_id}`)
    expect(status.json).toEqual(
      expect.objectContaining({
        kind: 'capture',
        state: 'complete',
        done: true,
      }),
    )

    const update = await f.call('/updates', {
      body: { target: { account: 'fake:@bob' }, options: { posts: 'none' } },
    })
    expect(update.status).toBe(202)
    expect(update.json).toEqual(
      expect.objectContaining({
        update_id: expect.any(String),
        status_url: `/agent/v1/updates/${update.json.update_id}`,
        kind: 'update',
        update: expect.objectContaining({ target: 'collection', accounts: 1 }),
      }),
    )
    expect(
      (await f.call('/captures', { body: { url: 'https://nowhere.test/' } }))
        .json.error,
    ).toBe('invalid_request')
  })

  test('watches an account or a folder; turning one off is all it can do to one', async () => {
    const f = await setup()
    const made = await f.call('/watches', {
      method: 'PUT',
      body: {
        target: { account: 'fake:@alice' },
        every: { count: 1, unit: 'day' },
      },
    })
    expect(made.status).toBe(200)
    expect(made.json).toEqual(
      expect.objectContaining({
        target: 'account',
        target_id: f.ids['7'],
        every: { count: 1, unit: 'day' },
        time_zone: 'UTC',
        enabled: true,
        next_run_at: expect.any(String),
      }),
    )
    // One watch per target: watching it again changes it.
    const again = await f.call('/watches', {
      method: 'PUT',
      body: {
        target: { account: f.ids['7'] },
        every: { count: 2, unit: 'week' },
        time_zone: 'Europe/Berlin',
        options: { posts: 'none' },
      },
    })
    expect(again.json.id).toBe(made.json.id)
    expect(again.json.every).toEqual({ count: 2, unit: 'week' })
    expect(again.json.time_zone).toBe('Europe/Berlin')
    expect(again.json.options.posts).toBe('none')
    const off = await f.call(`/watches/${made.json.id}`, {
      method: 'PATCH',
      body: { enabled: false },
    })
    expect(off.json.enabled).toBe(false)
    expect((await f.call('/watches')).json.items).toEqual([off.json])
    const folder = (
      await f.call('/folders', { body: { name: 'Cats', filter: { q: 'cat' } } })
    ).json
    expect(
      (
        await f.call('/watches', {
          method: 'PUT',
          body: {
            target: { folder: folder.id },
            every: { count: 6, unit: 'hour' },
          },
        })
      ).json,
    ).toEqual(
      expect.objectContaining({
        target: 'folder',
        name: 'Cats',
        every: { count: 6, unit: 'hour' },
      }),
    )
    expect(
      (
        await f.call('/watches', {
          method: 'PUT',
          body: {
            target: { account: 'fake:@carol' },
            every: { count: 1, unit: 'day' },
          },
        })
      ).status,
    ).toBe(404)
    expect(
      (await f.call(`/watches/${made.json.id}`, { method: 'DELETE' })).status,
    ).toBe(404)
    const ro = f.token('ro')
    expect((await f.call('/watches', { token: ro })).status).toBe(200)
    expect(
      (
        await f.call(`/watches/${made.json.id}`, {
          token: ro,
          method: 'PATCH',
          body: { enabled: true },
        })
      ).status,
    ).toBe(403)
  })

  test('public links and capture accounts are listed, and revoked by an rw token', async () => {
    const f = await setup()
    const share = createShare(f.ctx.db, {
      target: 'collection',
      id: f.ids['7']!,
    })
    const listed = await f.call('/shares')
    expect(listed.json.items).toEqual([
      {
        id: share.id,
        url: `http://localhost/app/s/${share.slug}`,
        target: 'account',
        target_id: f.ids['7'],
        created_at: expect.any(String),
      },
    ])
    // Her posts are public through her account's link; Bob's are not.
    expect(ids((await f.call(`/shares?of=${f.ids.p1}`)).json.items)).toEqual([
      share.id,
    ])
    expect((await f.call(`/shares?of=${f.ids.p3}`)).json.items).toEqual([])
    const ro = f.token('ro')
    const unshare = (token?: string) =>
      f.call(`/shares/${share.id}/revoke`, { token, method: 'POST' })
    expect((await unshare(ro)).status).toBe(403)
    expect((await unshare()).json).toEqual({ id: share.id, revoked: true })
    expect((await f.call('/shares')).json.items).toEqual([])
    expect((await unshare()).status).toBe(404)

    const { id } = await addAccount(f.ctx, 'fake', {
      credential: Buffer.from('alice'),
      name: '工作号',
    })
    expect(
      (await f.call('/capture-accounts', { token: ro })).json.items,
    ).toEqual([
      {
        id,
        platform: 'fake',
        name: '工作号',
        username: 'fake',
        state: 'ready',
        selected: true,
      },
    ])
    const remove = (token?: string) =>
      f.call(`/capture-accounts/${id}/revoke`, { token, method: 'POST' })
    expect((await remove(ro)).status).toBe(403)
    expect((await remove()).json).toEqual({ id, revoked: true })
    expect((await f.call('/capture-accounts')).json.items).toEqual([])
    expect((await remove()).status).toBe(404)
  })

  test('background work pauses and resumes', async () => {
    const f = await setup()
    const paused = await f.call('/jobs', {
      method: 'PATCH',
      body: { paused: true, paused_types: ['upload'] },
    })
    expect(paused.json).toEqual(
      expect.objectContaining({ paused: true, paused_types: ['upload'] }),
    )
    expect(
      (await f.call('/jobs', { method: 'PATCH', body: { paused: false } })).json
        .paused,
    ).toBe(false)
    expect(
      (
        await f.call('/jobs', {
          method: 'PATCH',
          body: { paused_types: ['capture'] },
        })
      ).status,
    ).toBe(400)
  })

  test('nothing deletes', async () => {
    const f = await setup()
    for (const [method, path] of [
      ['DELETE', `/posts/${f.ids.p1}`],
      ['DELETE', `/accounts/${f.ids['7']}`],
      ['DELETE', '/tags/x'],
      ['DELETE', '/folders/x'],
    ] as const) {
      const response = await f.call(path, { method })
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
    }
    expect(
      f.ctx.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.label, 'agent'))
        .get(),
    ).toBeTruthy()
  })
})
