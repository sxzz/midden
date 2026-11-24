import { afterEach, describe, expect, test } from 'vitest'
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
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`

const bob = () => entity('author', 'fake.profile', 'bob', { name: 'Bob' })
const five = (key = 'profile') =>
  entity(key, 'fake.profile', '500', { name: 'Five', username: 'five' })

const routes: Record<string, () => Partial<FetchResponse>> = {
  // A profile whose timeline reposts r1.
  500: () => ({
    text: 'profile five',
    graph: graph(
      [five('root'), entity('post', 'fake.post', 'r1')],
      ['root', 'reposted', 'post'],
    ),
  }),
  bob: () => ({
    text: 'profile bob',
    graph: graph([entity('root', 'fake.profile', 'bob', { name: 'Bob' })]),
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

async function setup() {
  const made = libraryContext((req) => {
    const route = routes[req.externalId.replace(/^handle:/, '')]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    return route()
  })
  const c = made.ctx as AccountsContext
  ctx = c
  const ids: Record<string, string> = {}
  ids.five = (await capture(c, profile('500'))).collectionId
  ids.bob = (await capture(c, profile('bob'))).collectionId
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

    // A new filter selects the profile; its attached posts come with it.
    updateFolder(c.db, folder.id, {
      filter: 'entity_type=fake.profile&q=profile five',
    })
    expect((await read(slug)).body).toMatchObject({ posts: 0, profiles: 1 })
    expect(
      (
        (await read(slug, '/collections?kind=profile')).body as {
          items: { id: string }[]
        }
      ).items.map((i) => i.id),
    ).toEqual([ids.five])
    expect(
      ((await read(slug, '/collections')).body as { items: unknown[] }).items,
    ).toEqual([])
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
      filter: 'entity_type=fake.profile&q=profile five',
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
