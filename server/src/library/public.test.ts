import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, onTestFinished, test } from 'vitest'
import { collections } from '#db/schema.ts'
import { createApi } from '#http/app.ts'
import { createToken } from '#http/auth.ts'
import {
  capture,
  entity,
  graph,
  image,
  libraryContext,
} from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { deleteCollection } from './delete.ts'
import { createFolder, deleteFolder, updateFolder } from './folders.ts'
import { getCollection } from './read.ts'
import { createShare, listShares, revokeShare } from './shares.ts'
import { REMOTE_IMAGES } from './views.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`

const bob = () => entity('author', 'fake.profile', '600', { name: 'Bob' })
const five = (key = 'profile') =>
  entity(key, 'fake.profile', '500', { name: 'Five', username: 'five' })

/** The posts profile five pins, once a test says. */
let pinned: string[] | undefined
afterEach(() => {
  pinned = undefined
})

const routes: Record<string, () => Partial<FetchResponse>> = {
  // A profile whose timeline reposts r1.
  500: () => ({
    text: 'profile five',
    graph: graph(
      [
        pinned
          ? entity('root', 'fake.profile', '500', {
              name: 'Five',
              username: 'five',
              metadata: { pinned_posts: pinned },
            })
          : five('root'),
        entity('post', 'fake.post', 'r1'),
      ],
      ['root', 'reposted', 'post'],
    ),
  }),
  // Its avatar could not be saved: shown from the platform instead.
  600: () => ({
    text: 'profile bob',
    resources: [image('missing/bob.jpg', { purpose: 'avatar' })],
    graph: graph([entity('root', 'fake.profile', '600', { name: 'Bob' }, [0])]),
  }),
  // Written by the profile, with an image.
  a1: () => ({
    text: 'by five',
    resources: [image('a1.jpg')],
    graph: graph(
      [entity('root', 'fake.post', 'a1', {}, [0]), five('author')],
      ['root', 'authored_by', 'author'],
    ),
  }),
  // Mentions the profile.
  m1: () => ({
    text: 'mentions five',
    graph: graph(
      [entity('root', 'fake.post', 'm1'), bob(), five()],
      ['root', 'authored_by', 'author'],
      ['root', 'mentions', 'profile'],
    ),
  }),
  r1: () => ({
    text: 'reposted by five',
    graph: graph(
      [entity('root', 'fake.post', 'r1'), bob()],
      ['root', 'authored_by', 'author'],
    ),
  }),
  // Nothing to do with the profile; its image must never leak.
  x1: () => ({
    text: 'unrelated',
    resources: [image('x1.jpg', { sensitive: true })],
    graph: graph(
      [entity('root', 'fake.post', 'x1', {}, [0]), bob()],
      ['root', 'authored_by', 'author'],
    ),
  }),
  // Quotes a1: a saved post pointing at the shared one.
  q1: () => ({
    text: 'quotes a1',
    resources: [image('q1.jpg')],
    graph: graph(
      [
        entity('root', 'fake.post', 'q1', {}, [0]),
        bob(),
        entity('quote', 'fake.post', 'a1'),
      ],
      ['root', 'authored_by', 'author'],
      ['root', 'quoted', 'quote'],
    ),
  }),
  // Only its author's bio mentions the profile: not attached to it.
  e3: () => ({
    text: 'bio mention',
    graph: graph(
      [entity('root', 'fake.post', 'e3'), bob(), five()],
      ['root', 'authored_by', 'author'],
      ['author', 'mentions', 'profile'],
    ),
  }),
}

/**
 * When each post was published: newest a1, r1, q1, e3, m1, x1, unlike the
 * order they are captured in.
 */
const PUBLISHED: Record<string, string> = {
  a1: '2026-01-06T00:00:00Z',
  r1: '2026-01-05T00:00:00Z',
  q1: '2026-01-04T00:00:00Z',
  e3: '2026-01-03T00:00:00Z',
  m1: '2026-01-02T00:00:00Z',
  x1: '2026-01-01T00:00:00Z',
}

async function setup() {
  const made = libraryContext((req) => {
    const route = routes[req.externalId]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    const published = PUBLISHED[req.externalId]
    return { ...route(), ...(published ? { publishedAt: published } : {}) }
  })
  const c = made.ctx as AccountsContext
  ctx = c
  const ids: Record<string, string> = {}
  ids.five = (await capture(c, profile('500'))).collectionId
  ids.bob = (await capture(c, profile('600'))).collectionId
  for (const id of ['a1', 'm1', 'r1', 'x1', 'q1', 'e3'])
    ids[id] = (await capture(c, post(id))).collectionId
  const app = createApi({ ctx: c })
  const token = createToken(c.db, 'test')
  const owner = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
  const api = app.request.bind(app)
  /** A public read: no credentials at all. */
  const read = async (slug: string, path = '') => {
    const response = await api(`/public/${slug}${path}`)
    return {
      status: response.status,
      robots: response.headers.get('X-Robots-Tag'),
      body: (await response.json()) as never,
    }
  }
  return { c, ids, read, owner }
}

const share = (
  c: AccountsContext,
  target: 'folder' | 'collection',
  id: string,
) => createShare(c.db, { target, id }).slug

/** Every key anywhere in a JSON value. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, out)
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      out.add(key)
      keys(item, out)
    }
  return out
}

const NOT_FOUND = { status: 404, body: { error: '内容不存在或已删除' } }

describe('public shares', () => {
  test('a shared post reads alone; everything else is not found', async () => {
    const { c, ids, read } = await setup()
    const slug = share(c, 'collection', ids.a1!)
    expect(slug).toMatch(/^[\w-]{24}$/)

    const meta = await read(slug)
    expect(meta).toMatchObject({
      status: 200,
      robots: 'noindex, nofollow',
      body: { target: 'collection', collection_id: ids.a1 },
    })
    const shown = await read(slug, `/collections/${ids.a1}`)
    expect(shown.status).toBe(200)
    expect(shown.robots).toBe('noindex, nofollow')
    const body = shown.body as {
      text: string
      assets: { url?: string }[]
      graph: { entities: { key: string; saved_collection_id?: string }[] }
      incoming_relations?: unknown
    }
    expect(body.text).toBe('by five')
    expect(body.assets[0]!.url).toMatch(/^\/media\//)
    // The author is saved but not shared: no link to it.
    expect(
      body.graph.entities.find((e) => e.key === 'author')?.saved_collection_id,
    ).toBeUndefined()
    // q1 quotes it, but q1 is not shared.
    expect(body.incoming_relations).toBeUndefined()

    const history = await read(slug, `/collections/${ids.a1}/history`)
    expect(history.status).toBe(200)
    const point = (history.body as { items: { capture_id: string }[] })
      .items[0]!.capture_id
    expect(
      (await read(slug, `/collections/${ids.a1}/history/${point}`)).status,
    ).toBe(200)
    expect((await read(slug, `/collections/${ids.a1}/counts`)).status).toBe(200)
    expect(
      (await read(slug, `/collections/${ids.a1}/profile-changes`)).status,
    ).toBe(200)

    for (const other of [ids.five!, ids.x1!, ids.q1!, crypto.randomUUID()])
      for (const path of [
        '',
        '/history',
        '/counts',
        '/profile-changes',
        `/history/${point}`,
      ])
        expect(await read(slug, `/collections/${other}${path}`)).toMatchObject(
          NOT_FOUND,
        )
    // Not a folder, so there is no list; nor a profile's posts.
    expect(await read(slug, '/collections')).toMatchObject(NOT_FOUND)
    expect(
      await read(slug, `/collections?related_to=${ids.five}`),
    ).toMatchObject(NOT_FOUND)
  })

  test('a shared profile shows that it is suspended, and filters by it', async () => {
    const { c, ids, read } = await setup()
    const since = new Date('2026-11-02T00:00:00Z')
    c.db
      .update(collections)
      .set({ sourceState: 'suspended', sourceStateAt: since })
      .where(eq(collections.id, ids.five!))
      .run()
    c.db
      .update(collections)
      .set({ sourceState: 'deleted', sourceStateAt: since })
      .where(eq(collections.id, ids.a1!))
      .run()
    const slug = share(c, 'collection', ids.five!)
    expect((await read(slug, `/collections/${ids.five}`)).body).toMatchObject({
      source_state: 'suspended',
      source_state_at: since.toISOString(),
    })
    // Its posts gone from the platform, as a visitor may ask for them.
    const gone = await read(
      slug,
      `/collections?related_to=${ids.five}&source_state=deleted`,
    )
    expect(gone.status).toBe(200)
    expect(
      (gone.body as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual([ids.a1])
  })

  test("a shared profile's pinned posts link only within the share", async () => {
    const { c, ids, read } = await setup()
    pinned = []
    await capture(c, { refreshId: ids.five! })
    pinned = ['a1', 'x1']
    await capture(c, { refreshId: ids.five! })
    const slug = share(c, 'collection', ids.five!)
    const changes = await read(slug, `/collections/${ids.five}/profile-changes`)
    // a1 is the profile's own post, x1 is saved but not shared.
    expect(changes.body).toEqual({
      items: [
        expect.objectContaining({
          fields: [
            {
              field: 'pinned',
              before: [],
              after: [
                { id: 'a1', collection_id: ids.a1, text: 'by five' },
                { id: 'x1' },
              ],
            },
          ],
        }),
      ],
    })
  })

  test('a point of another collection is not found through a shared one', async () => {
    const { c, ids, read } = await setup()
    const slug = share(c, 'collection', ids.a1!)
    const other = await capture(c, post('x1'))
    expect(
      await read(slug, `/collections/${ids.a1}/history/${other.id}`),
    ).toMatchObject(NOT_FOUND)
  })

  test('a shared profile reads with its attached posts, and only those', async () => {
    const { c, ids, read } = await setup()
    const slug = share(c, 'collection', ids.five!)
    expect((await read(slug, `/collections/${ids.five}`)).status).toBe(200)
    for (const id of ['a1', 'm1', 'r1'])
      expect((await read(slug, `/collections/${ids[id]}`)).status).toBe(200)
    for (const id of ['x1', 'q1', 'e3', 'bob'])
      expect(await read(slug, `/collections/${ids[id]}`)).toMatchObject(
        NOT_FOUND,
      )

    const listed = await read(slug, `/collections?related_to=${ids.five}`)
    expect(listed.status).toBe(200)
    const items = (listed.body as { items: { id: string }[] }).items
    expect(items.map((item) => item.id).toSorted()).toEqual(
      [ids.a1, ids.m1, ids.r1].toSorted(),
    )
    // Another profile's posts are not listed through this one.
    expect(
      await read(slug, `/collections?related_to=${ids.bob}`),
    ).toMatchObject(NOT_FOUND)

    // Inside the share the author links to the shared profile.
    const a1 = (await read(slug, `/collections/${ids.a1}`)).body as {
      graph: { entities: { key: string; saved_collection_id?: string }[] }
    }
    expect(
      a1.graph.entities.find((e) => e.key === 'author')?.saved_collection_id,
    ).toBe(ids.five)
    // r1's author (bob) is saved, but not shared.
    const r1 = (await read(slug, `/collections/${ids.r1}`)).body as {
      graph: { entities: { key: string; saved_collection_id?: string }[] }
      incoming_relations?: { entity: { saved_collection_id?: string } }[]
    }
    expect(
      r1.graph.entities.find((e) => e.key === 'author')?.saved_collection_id,
    ).toBeUndefined()
    // Reposted by the shared profile, which links.
    expect(
      r1.incoming_relations?.map((r) => r.entity.saved_collection_id),
    ).toEqual([ids.five])
  })

  test("a folder is live: what its filter selects now, and its profiles' posts", async () => {
    const { c, ids, read } = await setup()
    const tag = updateAnnotation(c.db, ids.x1!, { tagNames: ['公开'] }).tags[0]!
    const folder = createFolder(c.db, {
      name: '公开的',
      filter: `entity_type=fake.post&tag=${tag.id}`,
    })
    const slug = share(c, 'folder', folder.id)
    expect((await read(slug)).body).toEqual({
      target: 'folder',
      name: '公开的',
      posts: 1,
      profiles: 0,
    })
    expect((await read(slug, `/collections/${ids.x1}`)).status).toBe(200)
    expect(await read(slug, `/collections/${ids.a1}`)).toMatchObject(NOT_FOUND)

    // Tagged later: public now, with no new link.
    updateAnnotation(c.db, ids.a1!, { tagIds: [tag.id] })
    expect((await read(slug, `/collections/${ids.a1}`)).status).toBe(200)
    const listed = (await read(slug, '/collections')).body as {
      items: { id: string }[]
    }
    expect(listed.items.map((i) => i.id).toSorted()).toEqual(
      [ids.a1, ids.x1].toSorted(),
    )
    // The filter stops matching x1: gone at once.
    updateAnnotation(c.db, ids.x1!, { tagIds: [] })
    expect(await read(slug, `/collections/${ids.x1}`)).toMatchObject(NOT_FOUND)
    expect(await read(slug, `/collections/${ids.x1}/history`)).toMatchObject(
      NOT_FOUND,
    )

    // A new filter selects the profile and, through its tag, the post it
    // wrote; the rest of its attached posts come with it.
    const own = updateAnnotation(c.db, ids.five!, { tagNames: ['五'] }).tags[0]!
    updateFolder(c.db, folder.id, { filter: `tag=${own.id}` })
    expect((await read(slug)).body).toMatchObject({ posts: 1, profiles: 1 })
    expect(
      (
        (await read(slug, '/collections?entity_type=fake.profile')).body as {
          items: { id: string }[]
        }
      ).items.map((i) => i.id),
    ).toEqual([ids.five])
    expect(
      (
        (await read(slug, '/collections?entity_type=fake.post')).body as {
          items: { id: string }[]
        }
      ).items.map((i) => i.id),
    ).toEqual([ids.a1])
    for (const id of ['five', 'a1', 'm1', 'r1'])
      expect((await read(slug, `/collections/${ids[id]}`)).status).toBe(200)
    for (const id of ['x1', 'q1', 'e3', 'bob'])
      expect(await read(slug, `/collections/${ids[id]}`)).toMatchObject(
        NOT_FOUND,
      )
    expect(
      (await read(slug, `/collections?related_to=${ids.five}`)).status,
    ).toBe(200)
    expect(
      await read(slug, `/collections?related_to=${ids.bob}`),
    ).toMatchObject(NOT_FOUND)
  })

  test('media of items outside the share are never issued', async () => {
    const { c, ids, read } = await setup()
    const hidden = getCollection(c, ids.x1!).assets[0]!.sha256!
    const quoting = getCollection(c, ids.q1!).assets[0]!.sha256!
    const slug = share(c, 'collection', ids.five!)
    const responses = [
      await read(slug),
      await read(slug, `/collections?related_to=${ids.five}`),
      ...(await Promise.all(
        ['five', 'a1', 'm1', 'r1', 'x1', 'q1'].map((id) =>
          read(slug, `/collections/${ids[id]}`),
        ),
      )),
    ]
    const text = JSON.stringify(responses)
    expect(text).not.toContain(hidden)
    // q1 quotes a1 but is outside the share, so neither it nor its media
    // show on a1.
    expect(text).not.toContain(quoting)
    expect(text).toContain(getCollection(c, ids.a1!).assets[0]!.sha256!)
  })

  test("no owner's records in public answers", async () => {
    const { c, ids, read } = await setup()
    updateAnnotation(c.db, ids.a1!, {
      note: '私人备注',
      tagNames: ['私人标签'],
    })
    const slug = share(c, 'collection', ids.five!)
    const answers = [
      (await read(slug, `/collections/${ids.a1}`)).body,
      (await read(slug, `/collections/${ids.five}`)).body,
      (await read(slug, `/collections?related_to=${ids.five}`)).body,
    ]
    const text = JSON.stringify(answers)
    expect(text).not.toContain('私人备注')
    expect(text).not.toContain('私人标签')
    const found = keys(answers)
    for (const key of [
      'saved_at',
      'storage_bytes',
      'total_storage_bytes',
      'version_id',
      'note',
      'tags',
    ])
      expect(found).not.toContain(key)
    for (const answer of answers.slice(0, 2) as {
      graph: { entities: object[] }
    }[])
      for (const entity of answer.graph.entities)
        expect(entity).not.toHaveProperty('id')
  })

  test('follows show every account, linking only those shared', async () => {
    // The fake platform stands in for X, whose image addresses last.
    REMOTE_IMAGES.add('fake')
    onTestFinished(() => {
      REMOTE_IMAGES.delete('fake')
    })
    const { c, ids, read } = await setup()
    const entityOf = (id: string) =>
      c.db.get<{ id: string }>(
        sql`SELECT root_entity_id AS id FROM catalog WHERE collection_id = ${id}`,
      )!.id
    const day = Date.parse('2026-11-01T00:00:00Z')
    // Five unfollowed bob, whose profile is saved.
    c.db.run(sql`INSERT INTO follow_edges
      (follower_id, followee_id, first_seen_at, last_seen_at, ended_at)
      VALUES (${entityOf(ids.five!)}, ${entityOf(ids.bob!)}, ${day},
        ${day + 1000}, ${day + 2000})`)
    type Changes = {
      items: {
        account: {
          name?: string
          collection_id?: string
          avatar?: { remote_url?: string; url?: string }
        }
      }[]
    }

    const slug = share(c, 'collection', ids.five!)
    expect((await read(slug, `/collections/${ids.five}/follows`)).status).toBe(
      200,
    )
    const changes = await read(slug, `/collections/${ids.five}/follow-changes`)
    expect(changes.status).toBe(200)
    expect((changes.body as Changes).items.map((i) => i.account)).toEqual([
      expect.objectContaining({ name: 'Bob' }),
    ])
    expect(
      (changes.body as Changes).items[0]!.account.collection_id,
    ).toBeUndefined()
    // Out of scope, bob still shows his name and avatar, here from X itself.
    expect((changes.body as Changes).items[0]!.account.avatar).toMatchObject({
      remote_url: 'https://m.test/missing/bob.jpg',
    })
    expect(
      (changes.body as Changes).items[0]!.account.avatar,
    ).not.toHaveProperty('url')
    for (const path of ['/follows', '/follow-changes'])
      expect(await read(slug, `/collections/${ids.bob}${path}`)).toMatchObject(
        NOT_FOUND,
      )

    // A folder holding both profiles links bob.
    const folder = createFolder(c.db, {
      name: '账号',
      filter: 'entity_type=fake.profile',
    })
    const both = share(c, 'folder', folder.id)
    const linked = await read(both, `/collections/${ids.five}/follow-changes`)
    expect((linked.body as Changes).items[0]!.account.collection_id).toBe(
      ids.bob,
    )
    // In scope, bob's own page shows the platform's avatar like a saved one.
    const page = await read(both, `/collections/${ids.bob}`)
    expect(page.status).toBe(200)
    expect(
      (page.body as { graph: { entities: { assets?: object[] }[] } }).graph
        .entities[0]!.assets,
    ).toEqual([
      expect.objectContaining({
        purpose: 'avatar',
        remote_url: 'https://m.test/missing/bob.jpg',
      }),
    ])
  })

  test('the follow graph shows every account, linking only those shared', async () => {
    // The fake platform stands in for X, whose image addresses last.
    REMOTE_IMAGES.add('fake')
    onTestFinished(() => {
      REMOTE_IMAGES.delete('fake')
    })
    const { c, ids, read, owner } = await setup()
    const entityOf = (id: string) =>
      c.db.get<{ id: string }>(
        sql`SELECT root_entity_id AS id FROM catalog WHERE collection_id = ${id}`,
      )!.id
    const day = Date.parse('2026-11-01T00:00:00Z')
    // Five and bob follow each other.
    for (const [from, to] of [
      [ids.five!, ids.bob!],
      [ids.bob!, ids.five!],
    ])
      c.db.run(sql`INSERT INTO follow_edges
        (follower_id, followee_id, first_seen_at, last_seen_at)
        VALUES (${entityOf(from)}, ${entityOf(to)}, ${day}, ${day})`)
    type Graph = {
      nodes: {
        name?: string
        kind?: string
        collection_id?: string
        avatar?: { remote_url?: string }
      }[]
      edges: [number, number][]
    }

    const slug = share(c, 'collection', ids.five!)
    const shown = await read(slug, `/collections/${ids.five}/graph`)
    expect(shown.status).toBe(200)
    const graph = shown.body as Graph
    expect(graph.nodes).toEqual([
      expect.objectContaining({ name: 'Five', collection_id: ids.five }),
      expect.objectContaining({
        name: 'Bob',
        kind: 'mutual',
        avatar: expect.objectContaining({
          remote_url: 'https://m.test/missing/bob.jpg',
        }),
      }),
    ])
    // Bob is saved, but outside the share: no link to him.
    expect(graph.nodes[1]).not.toHaveProperty('collection_id')
    expect(graph.edges).toEqual([
      [0, 1],
      [1, 0],
    ])
    // The owner sees the link.
    const own = (await (
      await owner(`/collections/${ids.five}/graph`)
    ).json()) as Graph
    expect(own.nodes[1]!.collection_id).toBe(ids.bob)
    // Bob is not in the share, nor is x1.
    for (const other of [ids.bob!, ids.x1!, crypto.randomUUID()])
      expect(await read(slug, `/collections/${other}/graph`)).toMatchObject(
        NOT_FOUND,
      )

    // A folder holding both profiles links bob.
    const folder = createFolder(c.db, {
      name: '账号',
      filter: 'entity_type=fake.profile',
    })
    const both = share(c, 'folder', folder.id)
    const linked = (await read(both, `/collections/${ids.five}/graph`))
      .body as Graph
    expect(linked.nodes[1]!.collection_id).toBe(ids.bob)
  })

  test('revoked, unknown and malformed slugs are not found', async () => {
    const { c, ids, read } = await setup()
    const made = createShare(c.db, { target: 'collection', id: ids.a1! })
    // Sharing again gives the same link.
    expect(createShare(c.db, { target: 'collection', id: ids.a1! })).toEqual(
      made,
    )
    revokeShare(c.db, made.id)
    for (const slug of [made.slug, 'A'.repeat(24), 'short', `${made.slug}x`]) {
      expect(await read(slug)).toMatchObject(NOT_FOUND)
      expect(await read(slug, `/collections/${ids.a1}`)).toMatchObject(
        NOT_FOUND,
      )
    }
    // A new link is a new address; the old one stays dead.
    const again = share(c, 'collection', ids.a1!)
    expect(again).not.toBe(made.slug)
    expect(await read(made.slug)).toMatchObject(NOT_FOUND)
    expect(() => revokeShare(c.db, made.id)).toThrow()
  })

  test('deleting the target ends its links for good', async () => {
    const { c, ids, read } = await setup()
    const slug = share(c, 'collection', ids.a1!)
    const folder = createFolder(c.db, { name: 'f', filter: 'q=by five' })
    const folderSlug = share(c, 'folder', folder.id)
    deleteCollection(c.db, ids.a1!)
    deleteFolder(c.db, folder.id)
    // Saved again: the old address does not come back.
    await capture(c, post('a1'))
    expect(await read(slug)).toMatchObject(NOT_FOUND)
    expect(await read(folderSlug)).toMatchObject(NOT_FOUND)
    expect(listShares(c.db)).toEqual([])
  })

  test('the owner lists what makes a collection public', async () => {
    const { c, ids, owner } = await setup()
    const folder = createFolder(c.db, {
      name: '五',
      filter: 'q=five',
    })
    const viaFolder = createShare(c.db, { target: 'folder', id: folder.id })
    const direct = createShare(c.db, { target: 'collection', id: ids.r1! })
    const response = await owner(`/shares?collection=${ids.r1}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { ...viaFolder, name: '五' },
      direct,
    ])
    expect(await (await owner(`/shares?collection=${ids.x1}`)).json()).toEqual(
      [],
    )

    const created = await owner('/shares', {
      method: 'POST',
      body: JSON.stringify({ target: 'collection', id: ids.x1 }),
    })
    expect(created.status).toBe(200)
    const made = (await created.json()) as { id: string }
    expect(
      (await owner(`/shares/${made.id}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect(
      (
        await owner('/shares', {
          method: 'POST',
          body: JSON.stringify({ target: 'folder', id: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(404)
  })

  test('managing links needs the owner', async () => {
    const { c } = await setup()
    const app = createApi({ ctx: c })
    expect((await app.request('/shares')).status).toBe(401)
    expect(
      (
        await app.request('/shares', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'folder', id: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(401)
  })
})

describe('public lists', () => {
  type Listed = { items: { id: string }[] }
  type Authors = { items: { id: string; name: string; count: number }[] }
  // Without a captured author name, an author is labelled by its id.
  const BOB = '600'
  const FIVE = '500'

  /** Tag these posts and share a folder of the tagged posts. */
  async function tagged(...names: string[]) {
    const made = await setup()
    const { c, ids } = made
    const tag = updateAnnotation(c.db, ids[names[0]!]!, {
      tagNames: ['公开'],
    }).tags[0]!
    for (const name of names.slice(1))
      updateAnnotation(c.db, ids[name]!, { tagIds: [tag.id] })
    const folder = createFolder(c.db, {
      name: '公开的',
      // The folder's own order is not the public list's.
      filter: `entity_type=fake.post&tag=${tag.id}&sort=updated&order=asc`,
    })
    const slug = share(c, 'folder', folder.id)
    const list = async (query = '') => {
      const { status, body } = await made.read(slug, `/collections${query}`)
      expect(status).toBe(200)
      return (body as Listed).items.map((item) => item.id)
    }
    const authors = async (query = '') => {
      const { status, body } = await made.read(
        slug,
        `/collections/authors${query}`,
      )
      expect(status).toBe(200)
      return (body as Authors).items
    }
    return { ...made, tag, slug, list, authors }
  }

  test('newest posts first by default, whatever order the folder keeps', async () => {
    const all = ['a1', 'm1', 'r1', 'x1', 'q1', 'e3']
    const { ids, list, read, slug, c } = await tagged(...all)
    const byName = (...names: string[]) => names.map((name) => ids[name])
    expect(await list()).toEqual(byName('a1', 'r1', 'q1', 'e3', 'm1', 'x1'))
    expect(await list('?order=asc')).toEqual(
      byName('x1', 'm1', 'e3', 'q1', 'r1', 'a1'),
    )
    expect(await list('?sort=published&order=desc')).toEqual(await list())
    // Of the private list's other orders, only the update time is offered.
    expect(await list('?sort=updated')).toEqual(
      byName('e3', 'q1', 'x1', 'r1', 'm1', 'a1'),
    )
    // Save time and size are the owner's, never told.
    for (const sort of ['saved', 'storage', 'bogus'])
      expect(await read(slug, `/collections?sort=${sort}`)).toMatchObject({
        status: 400,
        body: { error: '请求无效' },
      })

    // A shared profile's posts, the same way.
    const profile = share(c, 'collection', ids.five!)
    const posts = (await read(profile, `/collections?related_to=${ids.five}`))
      .body as Listed
    expect(posts.items.map((item) => item.id)).toEqual(byName('a1', 'r1', 'm1'))
  })

  test('accounts updated last first by default', async () => {
    const { c, ids, read } = await setup()
    const folder = createFolder(c.db, {
      name: '账号',
      filter: 'entity_type=fake.profile&sort=saved&order=asc',
    })
    const slug = share(c, 'folder', folder.id)
    // The visitor's 账号 tab.
    const list = async (query = '') =>
      (
        (await read(slug, `/collections?entity_type=fake.profile${query}`))
          .body as Listed
      ).items.map((item) => item.id)
    // Bob was saved after five, which is captured again now.
    await capture(c, profile('500'))
    expect(await list()).toEqual([ids.five, ids.bob])
    expect(await list('&order=asc')).toEqual([ids.bob, ids.five])
    expect(await list('&sort=updated&order=desc')).toEqual(await list())
  })

  test("a visitor's filters only narrow the folder's", async () => {
    const { ids, list, authors, read, slug, c } = await tagged('a1', 'm1', 'x1')
    const set = async (query: string) => (await list(query)).toSorted()
    const of = (...names: string[]) =>
      names.map((name) => ids[name]!).toSorted()
    expect(await set('')).toEqual(of('a1', 'm1', 'x1'))
    // q1 has an image too, but is not in the folder.
    expect(await set('?media_type=image')).toEqual(of('a1', 'x1'))
    expect(await set('?sensitive=contains')).toEqual(of('x1'))
    expect(await set('?q=quotes')).toEqual([])
    const bob = (await authors()).find((a) => a.name === BOB)!.id
    // Bob wrote r1, q1 and e3 as well, outside the folder.
    expect(await set(`?author=${encodeURIComponent(bob)}`)).toEqual(
      of('m1', 'x1'),
    )
    // Another kind or an emptied filter selects nothing more.
    expect(await set('?entity_type=fake.profile')).toEqual([])
    expect(await set('?entity_type=fake.post,fake.profile')).toEqual(
      of('a1', 'm1', 'x1'),
    )
    expect(await set('?entity_type=&q=')).toEqual(of('a1', 'm1', 'x1'))
    // A bad value is refused as on the private list.
    expect((await read(slug, '/collections?media_type=gif')).status).toBe(400)

    // A shared profile's posts narrow the same way.
    const profile = share(c, 'collection', ids.five!)
    const posts = (
      await read(profile, `/collections?related_to=${ids.five}&q=mentions`)
    ).body as Listed
    expect(posts.items.map((item) => item.id)).toEqual([ids.m1])
  })

  test('a tag or a save date is refused, never applied', async () => {
    const { ids, tag, read, slug, c } = await tagged('a1')
    for (const path of [
      `/collections?tag=${tag.id}`,
      `/collections?tag=`,
      `/collections?not_tag=${tag.id}`,
      '/collections?tag_mode=all',
      `/collections?related_to=${ids.five}&tag=${tag.id}`,
      `/collections/authors?tag=${tag.id}`,
      '/collections?saved_from=2026-01-01',
      '/collections?saved_before=2026-01-01',
      '/collections?saved_within=7d',
      '/collections?saved_within=7d&time_zone=Asia/Shanghai',
      '/collections?time_zone=UTC',
      '/collections?saved_from=',
      `/collections?related_to=${ids.five}&saved_within=7d`,
    ])
      expect(await read(slug, path)).toMatchObject({
        status: 400,
        body: { error: '请求无效' },
      })
    const profile = share(c, 'collection', ids.five!)
    expect(
      (await read(profile, `/collections?related_to=${ids.five}&tag=${tag.id}`))
        .status,
    ).toBe(400)
    expect(
      (await read(profile, `/collections?related_to=${ids.five}&sort=storage`))
        .status,
    ).toBe(400)
  })

  test('the 关系 filter is refused, and its accounts are not listed', async () => {
    const { ids, read, slug, c } = await tagged('a1')
    const pat = encodeURIComponent('fake/fake.profile/5')
    for (const path of [
      `/collections?rel_of=${pat}&rel=following`,
      `/collections?rel_of=${pat}`,
      '/collections?rel=mutual',
      `/collections?related_to=${ids.five}&rel_of=${pat}&rel=followers`,
      `/collections/authors?rel_of=${pat}&rel=following`,
      `/collections?rel_of=${pat}&rel_of=${pat}2&rel=following&rel_min=2`,
      `/collections?rel_min=1`,
    ])
      expect(await read(slug, path)).toMatchObject({
        status: 400,
        body: { error: '请求无效' },
      })
    // The perspective list and comparing are the owner's alone.
    expect((await read(slug, '/collections/perspectives')).status).toBe(404)
    expect(
      (await read(slug, `/collections/compare?rel_of=${pat}`)).status,
    ).toBe(404)
    const profile = share(c, 'collection', ids.five!)
    // Nor may a visitor see a graph from an account of their choosing.
    expect(
      (await read(profile, `/collections/${ids.five}/graph?viewer=${pat}`))
        .status,
    ).toBe(400)
    expect(
      (await read(profile, `/collections/${ids.five}/graph`)).body,
    ).not.toHaveProperty('viewer')
    expect(
      (
        await read(
          profile,
          `/collections?related_to=${ids.five}&rel_of=${pat}&rel=following`,
        )
      ).status,
    ).toBe(400)
  })

  test('the author list names only authors within the share, counted there', async () => {
    const { ids, authors, read, c, tag } = await tagged('a1')
    // Bob has five saved posts, none of them shared.
    expect(await authors()).toEqual([
      { id: expect.any(String), name: FIVE, count: 1 },
    ])
    expect(await authors('?q=60')).toEqual([])
    updateAnnotation(c.db, ids.m1!, { tagIds: [tag.id] })
    const both = await authors()
    // Bob counts only m1, not the four posts of his outside the share.
    expect(both.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: FIVE, count: 1 },
      { name: BOB, count: 1 },
    ])
    const bob = both.find((a) => a.name === BOB)!.id
    expect(await authors(`?author=${encodeURIComponent(bob)}`)).toEqual([
      { id: bob, name: BOB, count: 1 },
    ])

    // A shared profile: the authors of its posts.
    const profile = share(c, 'collection', ids.five!)
    const listed = (
      await read(profile, `/collections/authors?related_to=${ids.five}`)
    ).body as Authors
    expect(listed.items.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: BOB, count: 2 },
      { name: FIVE, count: 1 },
    ])
    for (const path of [
      '/collections/authors',
      `/collections/authors?related_to=${ids.bob}`,
    ])
      expect(await read(profile, path)).toMatchObject(NOT_FOUND)
    // A single post has no list to filter.
    const single = share(c, 'collection', ids.a1!)
    expect(await read(single, '/collections/authors')).toMatchObject(NOT_FOUND)
  })

  test('the count is what the list shows over all its pages', async () => {
    const { ids, list, read, slug, c, tag } = await tagged('a1', 'm1', 'x1')
    const count = async (path: string, query = '') => {
      const { status, body } = await read(path, `/collections/count${query}`)
      expect(status).toBe(200)
      return body as { count: number; types: Record<string, number> }
    }
    expect(await count(slug)).toEqual({ count: 3, types: { 'fake.post': 3 } })
    for (const query of [
      '?media_type=image',
      '?sensitive=contains',
      '?q=quotes',
      '?entity_type=fake.profile',
      '?q=&sort=updated&order=asc',
    ])
      expect((await count(slug, query)).count).toBe((await list(query)).length)
    // A post tagged since then is counted again, not read from the cache.
    updateAnnotation(c.db, ids.q1!, { tagIds: [tag.id] })
    expect((await count(slug)).count).toBe(4)
    // What the list refuses, the count refuses.
    for (const query of [`?tag=${tag.id}`, '?saved_within=7d', '?rel=mutual'])
      expect((await read(slug, `/collections/count${query}`)).status).toBe(400)

    // A shared profile's attached posts, narrowed the same way.
    const profile = share(c, 'collection', ids.five!)
    expect((await count(profile, `?related_to=${ids.five}`)).count).toBe(3)
    expect(
      (await count(profile, `?related_to=${ids.five}&q=mentions`)).count,
    ).toBe(1)
    for (const path of ['', `?related_to=${ids.bob}`])
      expect(await read(profile, `/collections/count${path}`)).toMatchObject(
        NOT_FOUND,
      )
    expect(await read('no-such-slug', '/collections/count')).toMatchObject(
      NOT_FOUND,
    )
  })
})

describe('custom slugs', () => {
  async function slugs() {
    const made = await setup()
    const { c, ids, owner } = made
    const shareOf = (id: string) =>
      createShare(c.db, { target: 'collection', id })
    const patch = async (id: string, slug: string | null) => {
      const response = await owner(`/shares/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ slug }),
      })
      return { status: response.status, body: (await response.json()) as never }
    }
    const opens = async (slug: string) => (await made.read(slug)).body
    return {
      ...made,
      a1: shareOf(ids.a1!),
      m1: shareOf(ids.m1!),
      patch,
      opens,
    }
  }

  test('setting a slug replaces the old address at once', async () => {
    const { ids, a1, patch, opens, read } = await slugs()
    expect(await patch(a1.id, 'my-picks')).toMatchObject({
      status: 200,
      body: { id: a1.id, slug: 'my-picks', target_id: ids.a1 },
    })
    expect(await opens('my-picks')).toEqual({
      target: 'collection',
      collection_id: ids.a1,
    })
    expect(await read(a1.slug)).toMatchObject(NOT_FOUND)
    expect((await read('my-picks', `/collections/${ids.a1}`)).status).toBe(200)
    // The same slug again changes nothing.
    expect((await patch(a1.id, 'my-picks')).status).toBe(200)

    await patch(a1.id, 'better')
    expect(await read('my-picks')).toMatchObject(NOT_FOUND)
    expect(await opens('better')).toMatchObject({ collection_id: ids.a1 })

    // Back to random: a new random slug, the custom one gone.
    const reset = (await patch(a1.id, null)).body as { slug: string }
    expect(reset.slug).toMatch(/^[\w-]{24}$/)
    expect(reset.slug).not.toBe(a1.slug)
    expect(await read('better')).toMatchObject(NOT_FOUND)
    expect(await read(a1.slug)).toMatchObject(NOT_FOUND)
    expect(await opens(reset.slug)).toMatchObject({ collection_id: ids.a1 })
  })

  test('a slug a live link uses is taken; a freed one is not', async () => {
    const { c, ids, a1, m1, patch, opens } = await slugs()
    await patch(a1.id, 'taken')
    expect(await patch(m1.id, 'taken')).toEqual({
      status: 409,
      body: { error: '这个链接已被其他公开分享使用' },
    })
    expect(await opens('taken')).toMatchObject({ collection_id: ids.a1 })

    // Revoked: the slug may name another link; the old one stays revoked.
    revokeShare(c.db, a1.id)
    expect((await patch(m1.id, 'taken')).status).toBe(200)
    expect(await opens('taken')).toMatchObject({ collection_id: ids.m1 })
    expect((await patch(a1.id, 'other')).status).toBe(404)
    expect(listShares(c.db).map((s) => s.id)).toEqual([m1.id])

    // Replaced: the slug m1 had is free again.
    const r1 = createShare(c.db, { target: 'collection', id: ids.r1! })
    await patch(m1.id, 'moved')
    expect((await patch(r1.id, 'taken')).status).toBe(200)
    expect(await opens('taken')).toMatchObject({ collection_id: ids.r1 })
    expect(await opens('moved')).toMatchObject({ collection_id: ids.m1 })
  })

  test('only lowercase letters, digits and inner dashes, 3 to 64 long', async () => {
    const { a1, patch } = await slugs()
    for (const bad of [
      'ab',
      'x'.repeat(65),
      'Picks',
      '-abc',
      'abc-',
      'a_b',
      'a b',
      'a/b',
      '精选集',
      '',
    ])
      expect(await patch(a1.id, bad)).toMatchObject({
        status: 400,
        body: { error: expect.stringContaining('自定义链接') },
      })
    for (const good of ['abc', 'a-b', '2026', 'x'.repeat(64)])
      expect((await patch(a1.id, good)).status).toBe(200)
  })

  test('only the owner changes a live link', async () => {
    const { c, a1, patch } = await slugs()
    expect((await patch(crypto.randomUUID(), 'abc')).status).toBe(404)
    expect((await patch('nope', 'abc')).status).toBe(404)
    const app = createApi({ ctx: c })
    expect(
      (
        await app.request(`/shares/${a1.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: 'abc' }),
        })
      ).status,
    ).toBe(401)
  })
})
