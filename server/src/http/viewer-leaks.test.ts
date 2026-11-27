// What viewers read (docs/design/multi-user.md §5, §8.2, §8.3): the routes
// open to them, asked with many parameters over an archive whose tags,
// notes, private folders, capture accounts and records carry unique
// strings, never answer with any of them; a tag or a private folder
// answers exactly as one that does not exist; and what the read caches
// keep never mixes the admin's answers with a viewer's.
import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backup } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount } from '#accounts/accounts.ts'
import { pooledReads } from '#agent/runner.ts'
import { updateAnnotation } from '#library/annotations.ts'
import { createFolder } from '#library/folders.ts'
import { createShare } from '#library/shares.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { countedFolders } from '#testing/library.ts'
import { addViewer } from '#testing/users.ts'
import { createToken } from '#tokens/tokens.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { pooledWebReads } from './offload.ts'
import { createSession } from './sessions.ts'
import type { ReadThreadData } from '#reads/thread.ts'
import type { Principal } from '#users/principal.ts'

const WEB = 'https://midden.test/app/'
const ORIGIN = new URL(WEB).origin
const MISSING = '0193a0b0-0000-7000-8000-000000000000'

let fixture: AgentFixture | undefined
let pool: QueryPool | undefined
afterEach(async () => {
  await pool?.close()
  pool = undefined
  await fixture?.ctx.queue.stop()
  fixture = undefined
})

/**
 * The agent fixture's archive, and what only the admin may see: a tag on a
 * post and on an account (which covers its posts), notes, a folder kept
 * private (selecting by the tag), a capture account, and a shared folder
 * whose own query names the tag and the private folder.
 */
async function canaries() {
  fixture = await agentFixture()
  const { ctx, ids } = fixture
  const db = ctx.db
  const tag = 'CANARY-TAG-c1d2'
  const note = 'CANARY-NOTE-e3f4'
  updateAnnotation(db, ids.p1!, { tagNames: [tag], note })
  updateAnnotation(db, ids['7']!, { tagNames: [tag], note: `${note} 2` })
  const secret = createFolder(db, {
    name: 'CANARY-FOLDER-a5b6',
    query: `tag:"${tag}"`,
  })
  const shared = createFolder(db, {
    name: 'Shared cats',
    query: `cat OR tag:"${tag}" OR folder:"CANARY-FOLDER-a5b6"`,
  })
  createShare(db, { target: 'folder', id: shared.id })
  const account = await addAccount(ctx, 'fake', {
    credential: Buffer.from('alice'),
    name: 'CANARY-ACCOUNT-g7h8',
  })
  await countedFolders(db)
  const all = (sql: string) =>
    db.$client
      .prepare(sql)
      .all()
      .map((row) => row.id as string)
  const hidden = {
    strings: [tag, note, 'CANARY-FOLDER-a5b6', 'CANARY-ACCOUNT-g7h8'],
    ids: [
      ...all('SELECT id FROM tags'),
      secret.id,
      ...all('SELECT id FROM submissions'),
      ...all('SELECT id FROM updates'),
      account.id,
    ],
  }
  expect(hidden.ids.length).toBeGreaterThan(6)
  const viewer = addViewer(db)
  const api = createApi({ ctx, webAppUrl: WEB })
  const cookie = createSession(db, viewer)
  const adminCookie = createSession(db, adminId(db))
  const token = createToken(db, {
    user: viewer,
    label: 'script',
    permission: 'ro',
  }).secret
  const web = async (route: string, as = cookie) => {
    const response = await api.request(route, {
      headers: { Cookie: `${SESSION_COOKIE}=${as}`, Origin: ORIGIN },
    })
    return { status: response.status, text: await response.text() }
  }
  const agent = async (route: string, body?: unknown, as = token) => {
    const response = await fixture!.app.request(`/agent/v1${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${as}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, text: await response.text() }
  }
  return {
    ...fixture,
    db,
    tag,
    secret,
    shared,
    hidden,
    viewer,
    api,
    cookie,
    adminCookie,
    token,
    web,
    agent,
  }
}

type World = Awaited<ReturnType<typeof canaries>>

/** Every route open to viewers, with the parameters worth trying. */
function routes(w: World) {
  const { ids, db } = w
  const alice = encodeURIComponent('fake/fake.profile/7')
  const bob = encodeURIComponent('fake/fake.profile/8')
  const captureOf = (id: string) =>
    db.$client
      .prepare('SELECT id FROM captures WHERE collection_id = ? LIMIT 1')
      .get(id)!.id as string
  const entity = db.$client.prepare('SELECT id FROM entities LIMIT 1').get()!
    .id as string
  const lists = [
    '',
    '?q=cat',
    '?q=%E7%8C%AB',
    `?q=${encodeURIComponent('folder:"Shared cats"')}`,
    `?folder=${w.shared.id}`,
    `?folder=${w.shared.id}&q=cat`,
    `?rel_of=${alice}&rel=following`,
    '?sort=saved',
    '?sort=storage',
    '?entity_type=fake.profile',
  ]
  const v1 = [
    ...lists.map((q) => `/collections${q}`),
    ...lists.map((q) => `/collections/count${q}`),
    ...['tag', 'folder', 'handle', 'hashtag', 'domain'].flatMap((kind) => [
      `/query/suggest?kind=${kind}`,
      `/query/suggest?kind=${kind}&prefix=C`,
    ]),
    '/collections/authors',
    '/collections/perspectives',
    `/collections/perspectives?rel_of=${alice}`,
    `/collections/compare?rel_of=${alice}&rel_of=${bob}`,
    `/collections/graph?of=${alice}`,
    `/collections/graph?of=${alice}&viewer=${bob}`,
    '/usage',
    '/folders',
    '/session',
    '/tokens',
    '/sessions',
    '/passkeys',
    `/entities/${entity}`,
    ...Object.values(ids).flatMap((id) => [
      `/collections/${id}`,
      `/collections/${id}/history`,
      `/collections/${id}/history/${captureOf(id)}`,
      `/collections/${id}/counts`,
      `/collections/${id}/profile-changes`,
      `/collections/${id}/follows`,
      `/collections/${id}/follow-changes`,
      `/collections/${id}/graph`,
    ]),
  ]
  const searches = [
    '',
    '?q=cat',
    `?q=${encodeURIComponent(`folder:${w.shared.id}`)}`,
    `?folder=${w.shared.id}`,
    `?folder=${w.shared.id}&q=cat`,
    '?sort=saved',
  ]
  const agent: [string, unknown?][] = [
    ['/whoami'],
    ['/folders'],
    ...['posts', 'accounts'].flatMap((kind) =>
      searches.flatMap((q) => [
        [`/${kind}${q}`] as [string],
        [`/${kind}${q}${q ? '&' : '?'}view=full`] as [string],
      ]),
    ),
    ['/posts/batch', { ids: [ids.p1, ids.p2, ids.p3, ids.p4] }],
    ['/accounts/batch', { ids: [ids['7'], ids['8']] }],
    ['/accounts/batch', { ids: [ids['7']], view: 'compact' }],
    ...['p1', 'p2', 'p3', 'p4'].flatMap((p): [string][] => [
      [`/posts/${ids[p]}`],
      [`/posts/${ids[p]}?view=compact`],
      [`/posts/${ids[p]}/context`],
      [`/posts/${ids[p]}/metrics`],
    ]),
    ...['7', '8'].flatMap((a): [string][] => [
      [`/accounts/${ids[a]}`],
      [`/accounts/${ids[a]}/metrics`],
      [`/accounts/${ids[a]}/history`],
      [`/accounts/${ids[a]}/relations?rel=following`],
      [`/accounts/${ids[a]}/relations?rel=followers&view=full`],
      [`/accounts/${ids[a]}/relation-changes`],
    ]),
    ...[
      'author',
      'day',
      'week',
      'month',
      'hour',
      'weekday',
      'type',
      'media',
      'lang',
      'platform',
      'hashtag',
      'mention',
      'domain',
    ].flatMap((by): [string][] => [
      [`/aggregate?by=${by}`],
      [`/aggregate?by=${by}&q=cat`],
    ]),
  ]
  return { v1, agent }
}

/** Whether an answer gives away anything the viewer may not see. */
function leaks(w: World, text: string): string[] {
  return [...w.hidden.strings, ...w.hidden.ids].filter((s) => text.includes(s))
}

describe('what viewers read', () => {
  test('no route open to them answers with a tag, a note, a private folder, a capture account or a record', async () => {
    const w = await canaries()
    const { v1, agent } = routes(w)
    expect(v1.length).toBeGreaterThan(80)
    for (const route of v1) {
      const { status, text } = await w.web(route)
      expect([route, status]).toEqual([route, 200])
      expect([route, leaks(w, text)]).toEqual([route, []])
    }
    for (const [route, body] of agent) {
      const { status, text } = await w.agent(route, body)
      expect([route, status]).toEqual([route, 200])
      expect([route, leaks(w, text)]).toEqual([route, []])
    }
    // The admin sees them, so the canaries are where a leak would show.
    const own = await w.web('/folders', w.adminCookie)
    expect(own.text).toContain('CANARY-FOLDER-a5b6')
    const admin = createToken(w.db, {
      user: adminId(w.db),
      label: 'admin',
      permission: 'ro',
    }).secret
    expect(
      (await w.agent(`/posts/${w.ids.p1}`, undefined, admin)).text,
    ).toContain(w.tag)
  })

  test('the shared folder: listed by name and count alone, its query holds and is never said', async () => {
    const w = await canaries()
    expect(JSON.parse((await w.web('/folders')).text)).toEqual([
      {
        id: w.shared.id,
        name: 'Shared cats',
        count: expect.any(Number),
        types: expect.any(Object),
        counted_at: expect.any(String),
        stale: false,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ])
    expect(JSON.parse((await w.agent('/folders')).text)).toEqual({
      items: [
        {
          id: w.shared.id,
          name: 'Shared cats',
          posts: expect.any(Number),
          accounts: expect.any(Number),
          counted_at: expect.any(String),
          stale: false,
          created_at: expect.any(String),
          updated_at: expect.any(String),
        },
      ],
    })
    // Its query selects what the tag does too: the admin's, compiled as
    // theirs. Both read the same folder alike.
    const viewed = JSON.parse(
      (await w.agent(`/posts?folder=${w.shared.id}`)).text,
    )
    const admin = createToken(w.db, {
      user: adminId(w.db),
      label: 'admin',
      permission: 'ro',
    }).secret
    const owned = JSON.parse(
      (await w.agent(`/posts?folder=${w.shared.id}`, undefined, admin)).text,
    )
    expect(viewed.items.map((i: { id: string }) => i.id)).toEqual(
      owned.items.map((i: { id: string }) => i.id),
    )
    expect(viewed.items.length).toBeGreaterThan(0)
    expect(viewed.applied.folder).toEqual({
      id: w.shared.id,
      name: 'Shared cats',
    })
    // `parsed` keeps `folder:` as written.
    const parsed = JSON.parse(
      (await w.agent(`/posts?q=${encodeURIComponent('folder:"Shared cats"')}`))
        .text,
    )
    expect(parsed.parsed).toBe('folder:"Shared cats"')
    // The web app's list starts from it as well, posts and accounts both.
    const accounts = JSON.parse(
      (await w.agent(`/accounts?folder=${w.shared.id}`)).text,
    )
    const listed = JSON.parse(
      (await w.web(`/collections?folder=${w.shared.id}`)).text,
    )
    expect(listed.items.map((i: { id: string }) => i.id).toSorted()).toEqual(
      [...viewed.items, ...accounts.items]
        .map((i: { id: string }) => i.id)
        .toSorted(),
    )
  })

  test('a tag, a private folder and a nonexistent one answer the same; tag parameters and by=tag are refused', async () => {
    const w = await canaries()
    const same = async (
      read: (value: string) => Promise<{ status: number; text: string }>,
      present: string,
      absent: string,
    ) => {
      const a = await read(present)
      const b = await read(absent)
      expect(a.status).toBe(400)
      expect(a.text.replaceAll(present, '·')).toBe(
        b.text.replaceAll(absent, '·'),
      )
      return a
    }
    const fake = 'CANARY-TAG-zzzz'
    const q = (value: string) => encodeURIComponent(value)
    // `tag:` in a search, a count, an aggregation.
    for (const read of [
      (v: string) => w.agent(`/posts?q=${q(`tag:"${v}"`)}`),
      (v: string) => w.agent(`/accounts?q=${q(`-tag:"${v}" cat`)}`),
      (v: string) => w.agent(`/aggregate?by=day&q=${q(`tag:"${v}"`)}`),
      (v: string) => w.web(`/collections?q=${q(`tag:"${v}"`)}`),
      (v: string) => w.web(`/collections/count?q=${q(`tag:"${v}" OR cat`)}`),
    ])
      await same(read, w.tag, fake)
    // By id as by name.
    const tagId = w.hidden.ids[0]!
    await same((v) => w.agent(`/posts?q=${q(`tag:${v}`)}`), tagId, MISSING)
    // The agent API's tag parameters.
    for (const key of ['tag', 'not_tag'])
      await same((v) => w.agent(`/posts?${key}=${q(v)}`), w.tag, fake)
    expect((await w.agent(`/posts?tag_mode=all`)).status).toBe(400)
    // The web app's: refused outright, as on the public list.
    for (const key of ['tag', 'not_tag', 'tag_mode'])
      await same((v) => w.web(`/collections?${key}=${v}`), tagId, MISSING)
    // `folder:` and `folder=`.
    await same(
      (v) => w.agent(`/posts?q=${q(`folder:"${v}"`)}`),
      'CANARY-FOLDER-a5b6',
      'CANARY-FOLDER-zzzz',
    )
    await same(
      (v) => w.web(`/collections?q=${q(`folder:${v}`)}`),
      w.secret.id,
      MISSING,
    )
    for (const [read, status] of [
      [(v: string) => w.agent(`/posts?folder=${v}`), 404],
      [(v: string) => w.web(`/collections?folder=${v}`), 404],
      [(v: string) => w.web(`/collections/count?folder=${v}`), 404],
    ] as const) {
      const a = await read(w.secret.id)
      const b = await read(MISSING)
      expect(a.status).toBe(status)
      expect(a.text.replaceAll(w.secret.id, '·')).toBe(
        b.text.replaceAll(MISSING, '·'),
      )
    }
    // No `by=tag`, and nothing says it exists.
    const by = await w.agent('/aggregate?by=tag')
    expect(by.status).toBe(400)
    expect(
      (JSON.parse(by.text).message as string)
        .replace(/^by must be one of: /, '')
        .replace(/\.$/, '')
        .split(', '),
    ).not.toContain('tag')
    // The query box has no tags for them, and only the shared folder.
    expect(JSON.parse((await w.web('/query/suggest?kind=tag')).text)).toEqual({
      items: [],
    })
    expect(
      JSON.parse((await w.web('/query/suggest?kind=folder')).text),
    ).toEqual({ items: [{ value: 'Shared cats' }] })
  })

  test('the read caches keep the admin’s answers and a viewer’s apart', async () => {
    const w = await canaries()
    const admin = createToken(w.db, {
      user: adminId(w.db),
      label: 'admin',
      permission: 'ro',
    }).secret
    const routes = [
      `/collections?folder=${w.shared.id}`,
      `/collections/count?folder=${w.shared.id}`,
      '/collections/count?q=cat',
      `/collections?q=${encodeURIComponent('folder:"Shared cats"')}`,
    ]
    for (const route of routes) {
      const asViewer = await w.web(route)
      const asAdmin = await w.web(route, w.adminCookie)
      expect([route, (await w.web(route)).text]).toEqual([route, asViewer.text])
      expect([route, (await w.web(route, w.adminCookie)).text]).toEqual([
        route,
        asAdmin.text,
      ])
      // Read by the same conditions, the answers are the same: no cache
      // holds what one sees and the other does not.
      expect([route, asViewer.text]).toEqual([route, asAdmin.text])
    }
    // A tag the admin counts by is never answered from what the admin's
    // count kept.
    const tagged = `/collections/count?q=${encodeURIComponent(`tag:"${w.tag}"`)}`
    expect((await w.web(tagged, w.adminCookie)).status).toBe(200)
    expect((await w.web(tagged)).status).toBe(400)
    const search = `/posts?q=${encodeURIComponent(`tag:"${w.tag}"`)}`
    expect((await w.agent(search, undefined, admin)).status).toBe(200)
    expect((await w.agent(search)).status).toBe(400)
  })

  test('on the real read threads, as in place: refused, filtered and answered alike', async () => {
    const w = await canaries()
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-viewer-')),
      'db',
    )
    await backup(w.db.$client, file)
    pool = new QueryPool({
      script: READ_THREAD,
      workerData: {
        databasePath: file,
        mediaDir: path.join(tmpdir(), 'unused'),
        mediaKey: new TextEncoder().encode('test'),
        types: w.reader.types,
        countPointers: w.ctx.platforms.countPointers(),
        webAppUrl: WEB,
      } satisfies ReadThreadData,
    })
    const threaded = createApi({
      ctx: w.ctx,
      webAppUrl: WEB,
      reads: pooledWebReads(pool),
    })
    const there = async (route: string) => {
      const response = await threaded.request(route, {
        headers: { Cookie: `${SESSION_COOKIE}=${w.cookie}`, Origin: ORIGIN },
      })
      return { status: response.status, text: await response.text() }
    }
    for (const route of [
      ...routes(w).v1.filter((r) => !/^\/(?:session|tokens|sessions)$/.test(r)),
      // Refused there as here.
      '/captures',
      '/tags',
      `/collections/${w.ids.p1}/annotation`,
      '/shares',
      '/accounts',
    ]) {
      const a = await there(route)
      const b = await w.web(route)
      expect([route, a.status]).toEqual([route, b.status])
      expect([route, leaks(w, a.text)]).toEqual([route, []])
    }
    // The agent API's reads by name take the principal to the thread.
    const viewer: Principal = {
      userId: w.viewer,
      role: 'viewer',
      via: 'token',
      permission: 'ro',
    }
    const reads = pooledReads(pool)
    const found = await reads.run(viewer, 'get', {
      kind: 'posts',
      refs: [w.ids.p1!],
      view: 'full',
      origin: ORIGIN,
    })
    expect(found.items).toHaveLength(1)
    expect(leaks(w, JSON.stringify(found))).toEqual([])
    const refused = await reads
      .run(viewer, 'search', {
        kind: 'posts',
        params: { tag: [w.tag] },
        origin: ORIGIN,
      })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'invalid_request' })
  }, 30_000)
})
