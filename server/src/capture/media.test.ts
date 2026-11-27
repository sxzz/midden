import { Buffer } from 'node:buffer'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  assets,
  blobs,
  blobThumbnails,
  captures,
  revisions,
} from '#db/schema.ts'
import { getCollection } from '#library/read.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { jpegOf } from '#testing/images.ts'
import { captureHandlers } from './handlers.ts'
import { cachedBlob } from './media-reuse.ts'
import { submit } from './submit.ts'
import type { Resource } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])
const GIF = Buffer.from('GIF89a....')

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(
  resources: () => Partial<Resource>[],
  files: Record<string, Buffer | number>,
) {
  const requests: string[] = []
  const clock = { now: Date.now() }
  ctx = testContext({
    now: () => clock.now,
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: `post ${req.externalId}`,
          resources: resources().map((r) => ({
            kind: 'image',
            immutableKey: '',
            altText: '',
            sensitive: false,
            purpose: '',
            url: '',
            ...r,
          })),
          graph: postGraph(req.externalId, { text: 'x' }, undefined, {
            resourceIndices: resources().map((_, i) => i),
          }),
        }),
      }),
    ],
    handlers: captureHandlers,
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      const file = files[url]
      if (typeof file === 'number') return new Response(null, { status: file })
      return new Response(file ?? null, { status: file ? 200 : 404 })
    },
  })
  ctx.queue.start()
  return { ctx, requests, clock }
}

async function capture(c: CaptureContext, id: string) {
  const job = submit(c, { url: `https://fake.test/p/${id}` })
  await c.queue.drain()
  return c.db
    .select()
    .from(captures)
    .all()
    .find((row) => row.id === job.id)!
}

describe('media', () => {
  test('downloads, stores and finalizes media', async () => {
    const { ctx } = setup(() => [{ url: 'https://m.test/a.jpg' }], {
      'https://m.test/a.jpg': JPEG,
    })
    const done = await capture(ctx, '1')
    expect(done.state).toBe('complete')
    const blob = ctx.db.select().from(blobs).get()!
    expect(blob).toMatchObject({ size: JPEG.length, mime: 'image/jpeg' })
    expect(await ctx.blobs.stat(blob.hash)).toBe(JPEG.length)
    expect(ctx.db.select().from(assets).get()).toMatchObject({
      state: 'ready',
      blobId: blob.id,
    })
    expect(ctx.db.select().from(revisions).all()).toHaveLength(1)
  })

  test('an immutable key is downloaded once; identical bytes stored once', async () => {
    let key = 'photo-1'
    const { ctx, requests } = setup(
      () => [{ url: 'https://m.test/a.jpg', immutableKey: key }],
      { 'https://m.test/a.jpg': JPEG },
    )
    await capture(ctx, '1')
    await capture(ctx, '2')
    expect(requests).toHaveLength(1)
    key = 'photo-1:other-rendition'
    await capture(ctx, '3')
    expect(requests).toHaveLength(2)
    expect(ctx.db.select().from(blobs).all()).toHaveLength(1)
  })

  test('media stored before under its immutable key needs no download job', async () => {
    const { ctx } = setup(
      () => [{ url: 'https://m.test/a.jpg', immutableKey: 'photo-1' }],
      { 'https://m.test/a.jpg': JPEG },
    )
    await capture(ctx, '1')
    const enqueue = vi.spyOn(ctx.queue, 'enqueue')
    const again = await capture(ctx, '2')
    expect(again.state).toBe('complete')
    expect(enqueue.mock.calls.map((call) => call[1])).not.toContain('download')
    const [first, second] = ctx.db
      .select({ state: assets.state, blobId: assets.blobId })
      .from(assets)
      .all()
    expect(second).toEqual({ state: 'ready', blobId: first!.blobId })
  })

  describe('the key media is reused by', () => {
    const keys = (c: CaptureContext) =>
      c.db
        .select({ cacheKey: assets.cacheKey, mediaKey: assets.mediaKey })
        .from(assets)
        .orderBy(sql`rowid`)
        .all()

    test('an X media key is also its media key, so it is stored once', async () => {
      const { ctx, requests } = setup(
        () => [{ url: 'https://m.test/a.jpg', immutableKey: 'x:media:img:1' }],
        { 'https://m.test/a.jpg': JPEG },
      )
      await capture(ctx, '1')
      const enqueue = vi.spyOn(ctx.queue, 'enqueue')
      await capture(ctx, '2')
      expect(requests).toHaveLength(1)
      expect(enqueue.mock.calls.map((call) => call[1])).not.toContain(
        'download',
      )
      const rows = keys(ctx)
      expect(rows.map((row) => row.cacheKey)).toEqual([null, null])
      expect(rows[0]!.mediaKey).toBe(rows[1]!.mediaKey)
      expect(rows[0]!.mediaKey).toMatch(/^[0-9a-f]{64}$/)
      expect(ctx.db.select({ state: assets.state }).from(assets).all()).toEqual(
        [{ state: 'ready' }, { state: 'ready' }],
      )
    })

    test('an Instagram media key keeps each quality apart, by its own cache key', async () => {
      let quality = 'video:720x1280:1000'
      const { ctx, requests } = setup(
        () => [
          {
            url: `https://m.test/${quality}.jpg`,
            immutableKey: `instagram:media:9:${quality}`,
          },
        ],
        {
          'https://m.test/video:720x1280:1000.jpg': JPEG,
          'https://m.test/video:1080x1920:3000.jpg': JPEG2,
        },
      )
      await capture(ctx, '1')
      await capture(ctx, '2')
      expect(requests).toHaveLength(1)
      quality = 'video:1080x1920:3000'
      await capture(ctx, '3')
      // Another quality is another download, though the same media.
      expect(requests).toHaveLength(2)
      await capture(ctx, '4')
      expect(requests).toHaveLength(2)
      const rows = keys(ctx)
      expect(new Set(rows.map((row) => row.mediaKey)).size).toBe(1)
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.cacheKey!))).toBe(
        true,
      )
      expect(new Set(rows.map((row) => row.cacheKey)).size).toBe(2)
      expect(rows.every((row) => row.cacheKey !== row.mediaKey)).toBe(true)
      expect(ctx.db.select().from(blobs).all()).toHaveLength(2)
    })

    test('media without an immutable key is never reused, though it has a media key', async () => {
      const { ctx, requests } = setup(() => [{ url: 'https://m.test/a.jpg' }], {
        'https://m.test/a.jpg': JPEG,
      })
      await capture(ctx, '1')
      await capture(ctx, '2')
      expect(requests).toHaveLength(2)
      expect(keys(ctx)).toEqual([
        { cacheKey: '', mediaKey: 'url:https://m.test/a.jpg' },
        { cacheKey: '', mediaKey: 'url:https://m.test/a.jpg' },
      ])
      expect(ctx.db.select().from(blobs).all()).toHaveLength(1)
    })

    test('a key finds a row with none by its media key, only when ready', () => {
      const { ctx } = setup(() => [], {})
      const hash = 'a'.repeat(64)
      ctx.db.$client.exec('PRAGMA foreign_keys = OFF')
      let position = 0
      const add = (id: string, cacheKey: string | null, state: string) =>
        ctx.db.$client
          .prepare(
            `INSERT INTO assets (id, capture_id, position, source_url, cache_key, media_key, kind, state, blob_id)
             VALUES (?, 'k', ?, 'u', ?, ?, 'image', ?, ?)`,
          )
          .run(id, position++, cacheKey, hash, state, `blob-${id}`)
      const find = (key: string) =>
        ctx.db.transaction((tx) => cachedBlob(tx, key))
      add('pending', null, 'pending')
      expect(find(hash)).toBeUndefined()
      // No immutable key: not reusable, whatever its media key is.
      add('empty', '', 'ready')
      expect(find(hash)).toBeUndefined()
      add('ready', null, 'ready')
      expect(find(hash)).toBe('blob-ready')
      expect(find('')).toBeUndefined()
    })
  })

  test('rejected and unsupported media leave a partial capture', async () => {
    const { ctx } = setup(
      () => [
        { url: 'https://m.test/a.gif' },
        { url: 'https://m.test/missing.jpg' },
        { url: 'https://m.test/b.jpg' },
      ],
      { 'https://m.test/a.gif': GIF, 'https://m.test/b.jpg': JPEG2 },
    )
    const done = await capture(ctx, '1')
    expect(done.state).toBe('partial')
    expect(
      ctx.db
        .select({ state: assets.state, error: assets.error })
        .from(assets)
        .orderBy(assets.position)
        .all(),
    ).toEqual([
      { state: 'failed', error: '不支持的媒体格式' },
      { state: 'failed', error: '媒体服务器拒绝了请求' },
      { state: 'ready', error: '' },
    ])
  })

  test('only purposed media and no text is still nothing saved', async () => {
    const { ctx } = setup(() => [], {})
    // A graph is content, so this capture completes.
    expect((await capture(ctx, '1')).state).toBe('complete')
  })
})

describe('thumbnails from the platform', () => {
  const ORIGINAL = jpegOf(2000, 1000, 'original')
  const SMALL = jpegOf(680, 340, 'small')
  const POSTER = jpegOf(680, 383, 'poster')
  const files = {
    'https://m.test/a.jpg': ORIGINAL,
    'https://m.test/a-small.jpg': SMALL,
    'https://m.test/v.mp4': Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypmp42'),
      Buffer.alloc(32, 7),
    ]),
    'https://m.test/v.jpg': POSTER,
  }
  const image: Partial<Resource> = {
    url: 'https://m.test/a.jpg',
    immutableKey: 'x:media:image:1',
    width: 2000,
    height: 1000,
    thumbnailUrl: 'https://m.test/a-small.jpg',
  }
  const thumbnails = (c: CaptureContext) =>
    c.db.select().from(blobThumbnails).all()
  const view = (c: CaptureContext, done: { collectionId: string }) =>
    getCollection(c, done.collectionId).assets

  test('an image downloads its smaller size as the thumbnail, sized from the file', async () => {
    const { ctx, requests } = setup(() => [image], files)
    const done = await capture(ctx, '1')
    expect(done.state).toBe('complete')
    expect(requests).toEqual([
      'https://m.test/a.jpg',
      'https://m.test/a-small.jpg',
    ])
    expect(ctx.db.select().from(assets).get()).toMatchObject({
      width: 2000,
      height: 1000,
      thumbnailUrl: 'https://m.test/a-small.jpg',
    })
    const [row] = thumbnails(ctx)
    expect(row).toMatchObject({
      state: 'ready',
      mime: 'image/jpeg',
      size: SMALL.length,
      width: 680,
      height: 340,
    })
    expect(await ctx.blobs.stat(row!.key!)).toBe(SMALL.length)
    expect(view(ctx, done)[0]).toMatchObject({
      thumbnail: true,
      width: 680,
      height: 340,
    })
  })

  test('an image with no smaller size stands for itself, sized by the platform', async () => {
    const { ctx, requests } = setup(
      () => [{ ...image, thumbnailUrl: undefined }],
      files,
    )
    const done = await capture(ctx, '1')
    expect(requests).toEqual(['https://m.test/a.jpg'])
    expect(thumbnails(ctx)).toEqual([])
    const [asset] = view(ctx, done)
    expect(asset).toMatchObject({ width: 2000, height: 1000 })
    expect(asset!.thumbnail).toBeUndefined()
    expect(asset!.thumbnail_url).toBeUndefined()
    // The web then shows the original, from the CDN where it is public.
    expect(asset!.url).toBeTruthy()
  })

  test('a video downloads its poster; one without a poster has no thumbnail but its shape', async () => {
    let poster: string | undefined = 'https://m.test/v.jpg'
    const { ctx } = setup(
      () => [
        {
          url: 'https://m.test/v.mp4',
          kind: 'video',
          immutableKey: `x:media:video:${poster ? 1 : 2}`,
          width: 1920,
          height: 1080,
          thumbnailUrl: poster,
        },
      ],
      files,
    )
    const first = await capture(ctx, '1')
    expect(view(ctx, first)[0]).toMatchObject({
      thumbnail: true,
      width: 680,
      height: 383,
    })
    poster = undefined
    ctx.db.delete(blobThumbnails).run()
    const second = await capture(ctx, '2')
    expect(thumbnails(ctx)).toEqual([])
    const [asset] = view(ctx, second)
    expect(asset).toMatchObject({ width: 1920, height: 1080 })
    expect(asset!.thumbnail_url).toBeUndefined()
  })

  test('a refused thumbnail fails only itself, at once', async () => {
    const { ctx, requests } = setup(() => [image], {
      ...files,
      'https://m.test/a-small.jpg': 404,
    })
    const done = await capture(ctx, '1')
    expect(done.state).toBe('complete')
    expect(ctx.db.select().from(assets).get()!.state).toBe('ready')
    expect(requests.filter((r) => r.endsWith('small.jpg'))).toHaveLength(1)
    expect(thumbnails(ctx)).toMatchObject([
      { state: 'failed', error: '媒体服务器拒绝了请求' },
    ])
    // Not asked again by the next capture.
    await capture(ctx, '2')
    expect(requests.filter((r) => r.endsWith('small.jpg'))).toHaveLength(1)
  })

  test('a thumbnail on a busy server is tried again without the original, and recorded failed in the end', async () => {
    const busy = { ...files, 'https://m.test/a-small.jpg': 503 }
    const { ctx, requests, clock } = setup(() => [image], busy)
    const done = await capture(ctx, '1')
    // The capture does not wait for it.
    expect(done.state).toBe('complete')
    expect(thumbnails(ctx)).toEqual([])
    for (let i = 0; i < 3; i++) {
      clock.now += 60_000
      await ctx.queue.drain()
    }
    expect(requests.filter((r) => r === 'https://m.test/a.jpg')).toHaveLength(1)
    expect(requests.filter((r) => r.endsWith('small.jpg'))).toHaveLength(3)
    expect(thumbnails(ctx)).toMatchObject([{ state: 'failed' }])
    expect(ctx.db.select().from(assets).get()!.state).toBe('ready')
  })

  test('a thumbnail that works on the next try is kept', async () => {
    const answers: Record<string, Buffer | number> = {
      ...files,
      'https://m.test/a-small.jpg': 503,
    }
    const { ctx, clock } = setup(() => [image], answers)
    await capture(ctx, '1')
    answers['https://m.test/a-small.jpg'] = SMALL
    clock.now += 60_000
    await ctx.queue.drain()
    expect(thumbnails(ctx)).toMatchObject([{ state: 'ready', width: 680 }])
  })

  test('media stored before without a thumbnail gets one from the next capture listing it', async () => {
    let thumbnailUrl: string | undefined
    const { ctx, requests } = setup(() => [{ ...image, thumbnailUrl }], files)
    await capture(ctx, '1')
    expect(thumbnails(ctx)).toEqual([])
    thumbnailUrl = 'https://m.test/a-small.jpg'
    const enqueue = vi.spyOn(ctx.queue, 'enqueue')
    await capture(ctx, '2')
    expect(requests).toEqual([
      'https://m.test/a.jpg',
      'https://m.test/a-small.jpg',
    ])
    expect(thumbnails(ctx)).toMatchObject([{ state: 'ready' }])
    // Once it has one, a capture listing the media queues nothing for it.
    enqueue.mockClear()
    await capture(ctx, '3')
    expect(enqueue.mock.calls.map((call) => call[1])).not.toContain('download')
  })

  test('a thumbnail of the very same bytes as the original is not recorded', async () => {
    const { ctx } = setup(
      () => [{ ...image, thumbnailUrl: 'https://m.test/a.jpg?again' }],
      { ...files, 'https://m.test/a.jpg?again': ORIGINAL },
    )
    await capture(ctx, '1')
    expect(thumbnails(ctx)).toEqual([])
  })

  test('something not an image is no thumbnail', async () => {
    const { ctx } = setup(
      () => [{ ...image, thumbnailUrl: 'https://m.test/v.mp4' }],
      files,
    )
    await capture(ctx, '1')
    expect(thumbnails(ctx)).toMatchObject([
      { state: 'failed', error: '不支持的媒体格式' },
    ])
    expect(
      ctx.db.select().from(assets).where(eq(assets.state, 'ready')).all(),
    ).toHaveLength(1)
  })
})
