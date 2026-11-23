import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assets,
  blobs,
  blobThumbnails,
  revisions,
  sourceResponses,
} from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { FakeFailure } from '#testing/fake-platform.ts'
import {
  capture,
  entity,
  graph,
  image,
  libraryContext,
} from '#testing/library.ts'
import { deleteCollection } from './delete.ts'
import { getEntity } from './entities.ts'
import { listCollections } from './list.ts'
import {
  getCaptureCollection,
  getCollection,
  getRevision,
  listRevisions,
} from './read.ts'
import { getSource, listSources } from './sources.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'
import type { CollectionView, EntityView } from './views.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

type Route = () => Partial<FetchResponse>

/** Responses by requested external id. */
function setup(routes: Record<string, Route>) {
  const made = libraryContext((req) => {
    const route = routes[req.externalId]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    return route()
  })
  ctx = made.ctx
  return made
}

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`

function find(c: CollectionView, key: string): EntityView {
  const found = c.graph?.entities.find((e) => e.key === key)
  if (!found) throw new Error(`no entity ${key}`)
  return found
}

const avatarOf = (e: EntityView | undefined) =>
  e?.assets?.find((a) => a.purpose === 'avatar')?.id

describe('collection', () => {
  test('reads the head with media, signed URLs, counts and storage', async () => {
    const { ctx } = setup({
      1: () => ({
        text: 'hello',
        summary: 'A: hello',
        authorName: 'A',
        publishedAt: '2026-01-02T03:04:05Z',
        resources: [
          image('a.jpg', { altText: 'cat' }),
          image('avatar.jpg', { purpose: 'avatar' }),
        ],
        graph: graph(
          [
            entity('root', 'fake.post', '1', { text: 'hello', likes: 3 }, [0]),
            entity('author', 'fake.profile', '7', { name: 'A' }, [1]),
          ],
          ['root', 'authored_by', 'author'],
        ),
        sourceResponses: [
          {
            body: Buffer.from('{"a":1}'),
            contentType: 'application/json',
            sourceUrl: 'https://api.test/1',
            visibility: 1,
          },
        ],
      }),
    })
    const done = await capture(ctx, post('1'))
    const content = ctx.db
      .select()
      .from(assets)
      .where(eq(assets.purpose, ''))
      .get()!
    ctx.db
      .insert(blobThumbnails)
      .values({
        blobId: content.blobId!,
        state: 'ready',
        key: 'f'.repeat(64),
        size: 3,
        mime: 'image/webp',
      })
      .run()

    const c = getCollection(ctx, done.collectionId)
    expect(c).toMatchObject({
      id: done.collectionId,
      url: post('1'),
      external_id: '1',
      visibility: 'public',
      revision_id: done.revisionId,
      text: 'hello',
      summary: 'A: hello',
      author_name: 'A',
      published_at: '2026-01-02T03:04:05Z',
      warnings: [],
      saved_at: expect.any(String),
    })
    expect(c.assets).toEqual([
      expect.objectContaining({
        id: content.id,
        position: 0,
        state: 'ready',
        alt_text: 'cat',
        sensitive: false,
        mime: 'image/jpeg',
        thumbnail: true,
        url: expect.stringMatching(/^\/media\/[\da-f]{64}\?/),
        thumbnail_url: expect.stringMatching(/^\/media\/f{64}\?/),
      }),
    ])
    const root = find(c, 'root')
    // Counts are put back from the capture.
    expect(root.data).toEqual({ text: 'hello', likes: 3 })
    expect(root.assets?.map((a) => a.id)).toEqual([content.id])
    expect(root.saved_collection_id).toBe(done.collectionId)
    const author = find(c, 'author')
    expect(author.assets?.map((a) => a.purpose)).toEqual(['avatar'])
    expect(author.assets?.[0]?.url).toBeDefined()
    expect(author.assets?.[0]?.thumbnail_url).toBeUndefined()
    expect(author.saved_collection_id).toBeUndefined()

    const revision = ctx.db.select().from(revisions).get()!
    const media = ctx.db
      .select()
      .from(blobs)
      .all()
      .reduce((n, b) => n + b.size, 0)
    expect(c.storage_bytes).toBe(revision.contentBytes + media + 7)
    const [listed] = listCollections(ctx).items
    expect(listed?.storage_bytes).toBe(c.storage_bytes)
  })

  test('counts change without versions; each capture shows its own', async () => {
    let body: Record<string, unknown> = { text: 'same', likes: 1 }
    const { ctx } = setup({
      1: () => ({
        text: String(body.text),
        graph: graph([entity('root', 'fake.post', '1', body)]),
      }),
    })
    const first = await capture(ctx, post('1'))
    const id = first.collectionId
    body = { text: 'same', likes: 2 }
    const second = await capture(ctx, { refreshId: id })
    body = { text: 'same', likes: 3 }
    await capture(ctx, { refreshId: id })
    expect(ctx.db.select().from(revisions).all()).toHaveLength(1)
    const likes = (c: CollectionView) =>
      (find(c, 'root').data as { likes: number }).likes
    expect(likes(getCollection(ctx, id))).toBe(3)
    expect(second.revisionId).toBe(first.revisionId)
    expect(likes(getCaptureCollection(ctx, second.id))).toBe(2)
    expect(likes(getRevision(ctx, id, first.revisionId!))).toBe(1)
    const root = find(getCollection(ctx, id), 'root')
    expect(getEntity(ctx, root.id!).data).toEqual({ text: 'same', likes: 1 })

    body = { text: 'edited', likes: 4 }
    const edited = await capture(ctx, { refreshId: id })
    const history = listRevisions(ctx, id)
    expect(history.items.map((r) => r.id)).toEqual([
      edited.revisionId,
      first.revisionId,
    ])
    expect(history.next_cursor).toBeUndefined()
    const old = getRevision(ctx, id, first.revisionId!)
    expect(old.text).toBe('same')
    expect(old.observed_at).toBe(history.items[1]!.created_at)
    expect(getCollection(ctx, id).text).toBe('edited')
  })

  test('revisions page 20 at a time', async () => {
    let n = 0
    const { ctx } = setup({
      1: () => ({ text: `text ${n++}` }),
      2: () => ({ text: 'other' }),
    })
    const { collectionId: id } = await capture(ctx, post('1'))
    const other = await capture(ctx, post('2'))
    for (let i = 0; i < 20; i++) await capture(ctx, { refreshId: id })
    const first = listRevisions(ctx, id)
    expect(first.items).toHaveLength(20)
    const second = listRevisions(ctx, id, first.next_cursor)
    expect(second.items).toHaveLength(1)
    expect(second.next_cursor).toBeUndefined()
    expect(
      new Set([...first.items, ...second.items].map((r) => r.id)).size,
    ).toBe(21)
    expect(() =>
      listRevisions(ctx, other.collectionId, first.next_cursor),
    ).toThrow('invalid cursor')
    expect(() => listRevisions(ctx, id, 'garbage')).toThrow('invalid cursor')
  })

  test('only saved collections are readable', async () => {
    const { ctx } = setup({
      1: () => ({
        text: 'x',
        sourceResponses: [
          {
            body: Buffer.from('{}'),
            contentType: 'application/json',
            sourceUrl: 'https://api.test/1',
            visibility: 1,
          },
        ],
      }),
    })
    const done = await capture(ctx, post('1'))
    const source = listSources(ctx, done.collectionId)[0]!
    deleteCollection(ctx.db, done.collectionId)
    for (const read of [
      () => getCollection(ctx, done.collectionId),
      () => listRevisions(ctx, done.collectionId),
      () => getRevision(ctx, done.collectionId, done.revisionId!),
      () => listSources(ctx, done.collectionId),
      () => getSource(ctx, source.id),
      () => getCollection(ctx, randomUUIDv7()),
      () => getCollection(ctx, 'not-a-uuid'),
    ])
      expect(read).toThrow('not found')
    // Delivery of a capture's result does not depend on the library.
    expect(getCaptureCollection(ctx, done.id).text).toBe('x')
  })

  test('raw responses of finished captures, newest first', async () => {
    let n = 0
    const { ctx } = setup({
      1: () => ({
        text: 'x',
        sourceResponses: [
          {
            body: Buffer.from(`{"n":${++n}}`),
            contentType: 'application/json',
            sourceUrl: `https://api.test/${n}`,
            visibility: 1,
          },
        ],
      }),
    })
    const first = await capture(ctx, post('1'))
    const second = await capture(ctx, { refreshId: first.collectionId })
    const list = listSources(ctx, first.collectionId)
    expect(list).toEqual([
      expect.objectContaining({
        capture_id: second.id,
        provider_id: 'public',
        adapter_version: '1',
        content_type: 'application/json',
        source_url: 'https://api.test/2',
        size: 7,
        created_at: expect.any(String),
      }),
      expect.objectContaining({ capture_id: first.id }),
    ])
    const stored = ctx.db.select().from(sourceResponses).all()
    expect(list[0]!.sha256).toBe(
      stored.find((s) => s.captureId === second.id)!.sha256,
    )
    const body = getSource(ctx, list[0]!.id)
    expect(body.content_type).toBe('application/json')
    expect(body.body.toString()).toBe('{"n":2}')
  })
})

describe('entity links', () => {
  test('an alias links an entity to its saved collection', async () => {
    const { ctx } = setup({
      1: () => ({
        text: 'post',
        graph: graph(
          [
            entity('root', 'fake.post', '1'),
            entity('mention', 'fake.profile', 'handle:friend'),
            // Same platform and id, another type: never the profile.
            entity('other', 'fake.post', 'handle:friend'),
          ],
          ['root', 'mentions', 'mention'],
          ['root', 'mentions', 'other'],
        ),
      }),
      'handle:friend': () => ({
        text: 'profile',
        canonicalTarget: {
          url: profile('42'),
          platform: 'fake',
          kind: 'profile',
          objectScope: '',
          externalId: '42',
          collection: true,
          refreshOnSubmit: true,
        },
        graph: graph([entity('root', 'fake.profile', '42')]),
      }),
    })
    const { collectionId } = await capture(ctx, post('1'))
    const link = (key: string) =>
      find(getCollection(ctx, collectionId), key).saved_collection_id
    expect(link('mention')).toBeUndefined()
    const saved = await capture(ctx, profile('friend'))
    expect(link('mention')).toBe(saved.collectionId)
    expect(link('other')).toBeUndefined()
    expect(link('root')).toBe(collectionId)
    deleteCollection(ctx.db, saved.collectionId)
    expect(link('mention')).toBeUndefined()
  })

  test("a referenced author borrows its saved profile's own avatar", async () => {
    const { ctx } = setup({
      42: () => ({
        text: 'profile',
        // Another account in the same capture has its own avatar.
        resources: [
          image('other.jpg', { purpose: 'avatar' }),
          image('own.jpg', { purpose: 'avatar' }),
        ],
        graph: graph([
          entity('root', 'fake.profile', '42', { name: 'P' }, [1]),
          entity('other', 'fake.profile', '99', {}, [0]),
        ]),
      }),
      2: () => ({
        text: 'quoted',
        graph: graph(
          [
            entity('root', 'fake.post', '2'),
            entity('author', 'fake.profile', '42'),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }),
      1: () => ({
        text: 'quoting',
        graph: graph(
          [
            entity('root', 'fake.post', '1'),
            entity('author', 'fake.profile', '42'),
            entity('quote', 'fake.post', '2'),
          ],
          ['root', 'authored_by', 'author'],
          ['root', 'quoted', 'quote'],
          ['quote', 'authored_by', 'author'],
        ),
      }),
    })
    const owner = await capture(ctx, profile('42'))
    const own = avatarOf(find(getCollection(ctx, owner.collectionId), 'root'))
    expect(own).toBeDefined()
    const quoted = await capture(ctx, post('2'))
    const quoting = await capture(ctx, post('1'))

    const detail = getCollection(ctx, quoting.collectionId)
    expect(avatarOf(find(detail, 'author'))).toBe(own)
    expect(avatarOf(find(detail, 'root'))).toBeUndefined()
    expect(avatarOf(find(detail, 'quote'))).toBeUndefined()
    const incoming = getCollection(ctx, quoted.collectionId).incoming_relations
    expect(incoming).toHaveLength(1)
    expect(avatarOf(incoming?.[0]?.author)).toBe(own)
    const row = listCollections(ctx).items.find(
      (c) => c.id === quoting.collectionId,
    )!
    expect(avatarOf(find(row, 'author'))).toBe(own)

    deleteCollection(ctx.db, owner.collectionId)
    expect(
      avatarOf(find(getCollection(ctx, quoting.collectionId), 'author')),
    ).toBeUndefined()
  })

  test('a referenced post reads its saved summary, author and media', async () => {
    const { ctx } = setup({
      2: () => ({
        text: 'full text of 2',
        summary: 'summary of 2',
        resources: [image('q.jpg')],
        graph: graph(
          [
            entity('root', 'fake.post', '2', {}, [0]),
            entity('author', 'fake.profile', 'qa', { name: 'Quoted author' }),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }),
      1: () => ({
        text: 'quoting',
        graph: graph(
          [entity('root', 'fake.post', '1'), entity('quote', 'fake.post', '2')],
          ['root', 'quoted', 'quote'],
        ),
      }),
    })
    const quoted = await capture(ctx, post('2'))
    const quoting = await capture(ctx, post('1'))
    const quote = find(getCollection(ctx, quoting.collectionId), 'quote')
    expect(quote).toMatchObject({
      saved_collection_id: quoted.collectionId,
      saved_summary: 'summary of 2',
      saved_text: 'full text of 2',
      saved_author: { external_id: 'qa', data: { name: 'Quoted author' } },
    })
    expect(quote.assets?.map((a) => a.state)).toEqual(['ready'])
    deleteCollection(ctx.db, quoted.collectionId)
    const unsaved = find(getCollection(ctx, quoting.collectionId), 'quote')
    expect(unsaved.saved_summary).toBeUndefined()
    expect(unsaved.saved_author).toBeUndefined()
    expect(unsaved.assets).toBeUndefined()
  })

  test('authors read their current version; gone sources are marked', async () => {
    let name = 'first name'
    let gone = false
    const entry = (id: string) => () => {
      if (gone)
        throw new FakeFailure(status.FAILED_PRECONDITION, 'entry is gone', {
          'source-state': 'deleted',
        })
      return {
        text: id,
        graph: graph(
          [
            entity('root', 'fake.post', id),
            entity('author', 'fake.profile', 'pa', { name }),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }
    }
    const { ctx } = setup({
      a1: entry('a1'),
      a2: entry('a2'),
      q1: () => ({
        text: 'q1',
        graph: graph(
          [
            entity('root', 'fake.post', 'q1'),
            entity('author', 'fake.profile', 'pq', { name: 'quoter' }),
            entity('quote', 'fake.post', 'a1'),
            entity('quoted_author', 'fake.profile', 'pa', { name: 'partial' }),
          ],
          ['root', 'authored_by', 'author'],
          ['root', 'quoted', 'quote'],
          ['quote', 'authored_by', 'quoted_author'],
        ),
      }),
    })
    const first = await capture(ctx, post('a1'))
    const author = () => find(getCollection(ctx, first.collectionId), 'author')
    expect(author().current).toBeUndefined()
    // A partial copy inside another capture is not a newer profile.
    await capture(ctx, post('q1'))
    expect(author().current).toBeUndefined()
    name = 'renamed'
    await capture(ctx, post('a2'))
    expect(author().current?.data).toEqual({ name: 'renamed' })
    expect(author().data).toEqual({ name: 'first name' })

    gone = true
    await capture(ctx, { refreshId: first.collectionId })
    const marked = getCollection(ctx, first.collectionId)
    expect(marked).toMatchObject({
      source_state: 'deleted',
      source_state_at: expect.any(String),
      text: 'a1',
    })
    gone = false
    await capture(ctx, { refreshId: first.collectionId })
    const back = getCollection(ctx, first.collectionId)
    expect(back.source_state).toBeUndefined()
    expect(back.source_state_at).toBeUndefined()
  })

  test('incoming relations come from saved history only', async () => {
    let profileName = 'old profile'
    let reposts = true
    const { ctx } = setup({
      T: () => ({
        text: 'target',
        graph: graph([entity('root', 'fake.post', 'T', { name: 'target' })]),
      }),
      100: () => ({
        text: profileName,
        graph: reposts
          ? graph(
              [
                entity('root', 'fake.profile', '100', { name: profileName }),
                entity('target', 'fake.post', 'T'),
              ],
              ['root', 'reposted', 'target'],
            )
          : graph([
              entity('root', 'fake.profile', '100', { name: profileName }),
            ]),
      }),
      200: () => ({
        text: 'author',
        graph: graph([
          entity('root', 'fake.profile', '200', { name: 'saved' }),
        ]),
      }),
      Q: () => ({
        text: 'quote',
        graph: graph(
          [
            entity('root', 'fake.post', 'Q', { name: 'quote' }),
            entity('target', 'fake.post', 'T'),
            entity('author', 'fake.profile', '200', { name: 'quote author' }),
          ],
          ['root', 'quoted', 'target'],
          ['root', 'authored_by', 'author'],
        ),
      }),
    })
    const target = await capture(ctx, post('T'))
    const actor = await capture(ctx, profile('100'))
    // A later page need not repeat the repost; its newer data still labels it.
    profileName = 'latest profile'
    reposts = false
    await capture(ctx, profile('100'))
    const author = await capture(ctx, profile('200'))
    const quote = await capture(ctx, post('Q'))

    const check = (c: CollectionView) => {
      expect(c.graph?.entities).toHaveLength(1)
      expect(c.graph?.relations).toEqual([])
      const [quoted, reposted] = c.incoming_relations ?? []
      expect(c.incoming_relations).toHaveLength(2)
      expect(quoted).toMatchObject({
        type: 'quoted',
        entity: { saved_collection_id: quote.collectionId },
        author: {
          external_id: '200',
          saved_collection_id: author.collectionId,
          data: { name: 'quote author' },
        },
      })
      expect(reposted).toMatchObject({
        type: 'reposted',
        entity: {
          saved_collection_id: actor.collectionId,
          data: { name: 'latest profile' },
        },
      })
      expect(reposted?.author).toBeUndefined()
    }
    check(getCollection(ctx, target.collectionId))
    check(getRevision(ctx, target.collectionId, target.revisionId!))
    deleteCollection(ctx.db, quote.collectionId)
    expect(
      getCollection(ctx, target.collectionId).incoming_relations?.map(
        (r) => r.type,
      ),
    ).toEqual(['reposted'])
    expect(() => getEntity(ctx, randomUUIDv7())).toThrow('not found')
  })
})
