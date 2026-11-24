import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { fillViewHashes } from '#capture/finalize.ts'
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
  getHistoryPoint,
  listHistory,
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
    expect(likes(getHistoryPoint(ctx, id, first.id))).toBe(1)
    expect(likes(getHistoryPoint(ctx, id, second.id))).toBe(2)
    const root = find(getCollection(ctx, id), 'root')
    expect(getEntity(ctx, root.id!).data).toEqual({ text: 'same', likes: 1 })

    body = { text: 'edited', likes: 4 }
    const edited = await capture(ctx, { refreshId: id })
    expect(getCollection(ctx, id).text).toBe('edited')
    const old = getHistoryPoint(ctx, id, second.id)
    expect(old).toMatchObject({ text: 'same', revision_id: first.revisionId })
    expect(old.observed_at).toBe(second.finishedAt!.toISOString())
    expect(getHistoryPoint(ctx, id, edited.id).text).toBe('edited')
  })

  test('history has a point where the content or the counts changed', async () => {
    let text = 'same'
    let likes = 1
    let fail = false
    // The quoted post's counts come first or last as the platform lists them.
    let reversed = false
    const { ctx } = setup({
      1: () => {
        if (fail) throw new FakeFailure(status.FAILED_PRECONDITION, 'down')
        const entities = [
          entity('root', 'fake.post', '1', { text, likes }),
          entity('quote', 'fake.post', '2', { likes: 5 }),
        ]
        return {
          text,
          graph: graph(reversed ? entities.toReversed() : entities, [
            'root',
            'quoted',
            'quote',
          ]),
        }
      },
    })
    const first = await capture(ctx, post('1'))
    const id = first.collectionId
    const refresh = () => capture(ctx, { refreshId: id })
    // Identical captures, in whatever order the counts were written, and a
    // failed one in between, fold into the first.
    reversed = true
    await refresh()
    fail = true
    const failed = await refresh()
    expect(failed.state).toBe('failed')
    fail = false
    reversed = false
    await refresh()
    likes = 2
    const counted = await refresh()
    await refresh()
    text = 'edited'
    const edited = await refresh()
    // Back to counts seen before still differs from the capture just before.
    likes = 1
    const again = await refresh()
    await refresh()

    const history = listHistory(ctx, id)
    expect(history.items).toEqual([
      {
        capture_id: again.id,
        observed_at: again.finishedAt!.toISOString(),
        revision_id: edited.revisionId,
      },
      {
        capture_id: edited.id,
        observed_at: edited.finishedAt!.toISOString(),
        revision_id: edited.revisionId,
      },
      {
        capture_id: counted.id,
        observed_at: counted.finishedAt!.toISOString(),
        revision_id: first.revisionId,
      },
      {
        capture_id: first.id,
        observed_at: first.finishedAt!.toISOString(),
        revision_id: first.revisionId,
      },
    ])
    expect(history.next_cursor).toBeUndefined()
    expect(counted.revisionId).toBe(first.revisionId)
    const likesAt = (capture: string) =>
      (
        find(getHistoryPoint(ctx, id, capture), 'root').data as {
          likes: number
        }
      ).likes
    expect(likesAt(first.id)).toBe(1)
    expect(likesAt(counted.id)).toBe(2)
    expect(likesAt(edited.id)).toBe(2)
    expect(likesAt(again.id)).toBe(1)
    expect(() => getHistoryPoint(ctx, id, failed.id)).toThrow(
      '内容不存在或已删除',
    )
  })

  test('values reported inconsistently and counts not shown make no point', async () => {
    // The fake post type declares /facets volatile, as X does a bio's.
    let facets: object[] = []
    let quoteLikes = 5
    let likes = 1
    const { ctx } = setup({
      1: () => ({
        text: 'same',
        graph: graph(
          [
            entity('root', 'fake.post', '1', { text: 'same', likes, facets }),
            entity('quote', 'fake.post', '2', { likes: quoteLikes }),
          ],
          ['root', 'quoted', 'quote'],
        ),
      }),
    })
    const first = await capture(ctx, post('1'))
    const id = first.collectionId
    const refresh = () => capture(ctx, { refreshId: id })
    facets = [{ type: 'mention', original: 'someone' }]
    const flipped = await refresh()
    facets = []
    await refresh()
    // The quoted post's counts are its own page's, not this one's.
    quoteLikes = 6
    await refresh()
    likes = 2
    const counted = await refresh()

    expect(flipped.revisionId).toBe(first.revisionId)
    expect(ctx.db.select().from(revisions).all()).toHaveLength(1)
    expect(listHistory(ctx, id).items.map((p) => p.capture_id)).toEqual([
      counted.id,
      first.id,
    ])
  })

  /** A profile whose timeline, when read, lists two reposts. */
  function reposter(state: { timeline: boolean; name: string }) {
    return setup({
      100: () => ({
        text: state.name,
        graph: graph(
          [
            entity('root', 'fake.profile', '100', { name: state.name }),
            ...(state.timeline
              ? [
                  entity('r1', 'fake.post', 'T1'),
                  entity('r2', 'fake.post', 'T2'),
                ]
              : []),
          ],
          ...(state.timeline
            ? ([
                ['root', 'reposted', 'r1'],
                ['root', 'reposted', 'r2'],
              ] as [string, string, string][])
            : []),
        ),
      }),
    })
  }

  test('a profile timeline’s reposts make no point of their own', async () => {
    const state = { timeline: true, name: 'name' }
    const { ctx } = reposter(state)
    const first = await capture(ctx, profile('100'))
    const id = first.collectionId
    const refresh = () => capture(ctx, { refreshId: id })
    // An automatic refresh reads no timeline, then an explicit one does.
    state.timeline = false
    const bare = await refresh()
    state.timeline = true
    const again = await refresh()
    state.name = 'renamed'
    const renamed = await refresh()

    // Still revisions of their own: the reposts they record mark posts in
    // the profile's list and on the reposted posts.
    expect(bare.revisionId).not.toBe(first.revisionId)
    expect(again.revisionId).not.toBe(bare.revisionId)
    expect(listHistory(ctx, id).items.map((p) => p.capture_id)).toEqual([
      renamed.id,
      first.id,
    ])
  })

  test('revisions stored before view hashes fold once they are filled', async () => {
    const state = { timeline: true, name: 'name' }
    const { ctx } = reposter(state)
    const first = await capture(ctx, profile('100'))
    const id = first.collectionId
    state.timeline = false
    const bare = await refresh()
    state.timeline = true
    await refresh()
    function refresh() {
      return capture(ctx, { refreshId: id })
    }
    const points = () => listHistory(ctx, id).items.map((p) => p.capture_id)
    const folded = points()
    expect(folded).toEqual([first.id])

    // As stored before: no view hash, so each revision is its own point.
    ctx.db.update(revisions).set({ viewHash: null }).run()
    expect(points()).toHaveLength(3)
    expect(fillViewHashes(ctx.db, ctx.platforms, 2)).toBe(3)
    expect(fillViewHashes(ctx.db, ctx.platforms)).toBe(0)
    expect(points()).toEqual(folded)
    const hashes = ctx.db.select().from(revisions).all()
    expect(new Set(hashes.map((r) => r.viewHash)).size).toBe(1)
    expect(new Set(hashes.map((r) => r.id))).toContain(bare.revisionId)
  })

  test('history pages 20 points at a time across folded captures', async () => {
    let n = 0
    const { ctx } = setup({
      1: () => ({ text: `text ${Math.floor(n++ / 2)}` }),
      2: () => ({ text: 'other' }),
    })
    // Every other capture repeats the one before: 21 points of 42 captures.
    const { collectionId: id } = await capture(ctx, post('1'))
    const other = await capture(ctx, post('2'))
    for (let i = 0; i < 41; i++) await capture(ctx, { refreshId: id })
    const first = listHistory(ctx, id)
    expect(first.items).toHaveLength(20)
    const second = listHistory(ctx, id, first.next_cursor)
    expect(second.items).toHaveLength(1)
    expect(second.next_cursor).toBeUndefined()
    const points = [...first.items, ...second.items]
    const revisionIds = points.map((p) => p.revision_id)
    expect(new Set(revisionIds).size).toBe(21)
    // Each point is the first capture of its revision.
    const made = new Set(
      ctx.db
        .select()
        .from(revisions)
        .all()
        .map((r) => r.captureId),
    )
    expect(points.every((p) => made.has(p.capture_id))).toBe(true)
    expect(() =>
      listHistory(ctx, other.collectionId, first.next_cursor),
    ).toThrow('翻页位置无效，请刷新后重试')
    expect(() => listHistory(ctx, id, 'garbage')).toThrow(
      '翻页位置无效，请刷新后重试',
    )
    // A capture of another collection is not a point of this one.
    const [elsewhere] = listHistory(ctx, other.collectionId).items
    expect(() => getHistoryPoint(ctx, id, elsewhere!.capture_id)).toThrow(
      '内容不存在或已删除',
    )
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
      () => listHistory(ctx, done.collectionId),
      () => getHistoryPoint(ctx, done.collectionId, done.id),
      () => listSources(ctx, done.collectionId),
      () => getSource(ctx, source.id),
      () => getCollection(ctx, randomUUIDv7()),
      () => getCollection(ctx, 'not-a-uuid'),
    ])
      expect(read).toThrow('内容不存在或已删除')
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

  test('an incoming reposting account keeps its saved avatar', async () => {
    const { ctx } = setup({
      T: () => ({
        text: 'target',
        graph: graph([entity('root', 'fake.post', 'T')]),
      }),
      100: () => ({
        text: 'reposter',
        resources: [image('own.jpg', { purpose: 'avatar' })],
        graph: graph(
          [
            entity('root', 'fake.profile', '100', { name: 'reposter' }, [0]),
            entity('target', 'fake.post', 'T'),
          ],
          ['root', 'reposted', 'target'],
        ),
      }),
    })
    const target = await capture(ctx, post('T'))
    const actor = await capture(ctx, profile('100'))
    const own = avatarOf(find(getCollection(ctx, actor.collectionId), 'root'))
    expect(own).toBeDefined()
    const [reposted] = getCollection(
      ctx,
      target.collectionId,
    ).incoming_relations!
    expect(reposted?.type).toBe('reposted')
    expect(avatarOf(reposted?.entity)).toBe(own)
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
    check(getHistoryPoint(ctx, target.collectionId, target.id))
    deleteCollection(ctx.db, quote.collectionId)
    expect(
      getCollection(ctx, target.collectionId).incoming_relations?.map(
        (r) => r.type,
      ),
    ).toEqual(['reposted'])
    expect(() => getEntity(ctx, randomUUIDv7())).toThrow('内容不存在或已删除')
  })
})
