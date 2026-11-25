import { Buffer } from 'node:buffer'
import { rm } from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FsBlobStore } from '#blob/fs-store.ts'
import { mediaRoutes } from '#blob/route.ts'
import { S3_ATTEMPTS } from '#blob/s3.ts'
import { IMMUTABLE, objectPath } from '#blob/store.ts'
import { assets, blobs, blobThumbnails, captures, jobs } from '#db/schema.ts'
import { deleteCollection } from '#library/delete.ts'
import { removeMedia } from '#library/media-removal.ts'
import { getCollection } from '#library/read.ts'
import { testContext } from '#testing/context.ts'
import { fakeFfmpeg } from '#testing/fake-ffmpeg.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { FAKE_PUBLIC, FakeS3 } from '#testing/fake-s3.ts'
import { recordingLogger } from '#testing/logs.ts'
import { captureHandlers } from './handlers.ts'
import { collectCollections, collectMedia } from './maintenance.ts'
import { submit } from './submit.ts'
import { regenerateThumbnail } from './thumbnail.ts'
import type { BucketBlobStore } from '#blob/bucket-store.ts'
import type { MediaSigner } from '#blob/signer.ts'
import type { Resource } from '#platforms/protocol.ts'
import type { CaptureContext, Thumbnailer } from './context.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(200, 7),
])
const HOUR = 60 * 60_000

let s3: FakeS3
let ctx: CaptureContext | undefined
beforeEach(async () => {
  s3 = await new FakeS3().start()
})
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
  await s3.stop()
})

/**
 * A capture context whose media store is the fake bucket, or with `local`
 * the media directory alone.
 */
function setup(options: { thumbnailer?: Thumbnailer; local?: boolean } = {}) {
  const clock = { now: Date.now() }
  const media: Record<string, Partial<Resource>[]> = {}
  const files: Record<string, Buffer> = {
    'https://m.test/a.jpg': JPEG,
    'https://m.test/a.jpg?copy': JPEG,
    'https://m.test/v.mp4': VIDEO,
  }
  const logs = recordingLogger()
  let signer!: MediaSigner
  const c = testContext({
    now: () => clock.now,
    logger: logs.logger,
    thumbnailer: options.thumbnailer,
    handlers: captureHandlers,
    platforms: [
      fakePlatform({
        current: (req) => {
          const list = media[req.externalId] ?? []
          return {
            text: `post ${req.externalId}`,
            resources: list.map((r) => ({
              kind: 'image',
              immutableKey: '',
              altText: '',
              sensitive: false,
              purpose: '',
              url: '',
              ...r,
            })),
            graph: postGraph(req.externalId, {}, undefined, {
              resourceIndices: list.map((_, i) => i),
            }),
          }
        },
      }),
    ],
    fetch: (input) => {
      const file = files[String(input)]
      return Promise.resolve(
        new Response(file ?? null, { status: file ? 200 : 404 }),
      )
    },
    blobs: (m) => {
      signer = m.signer
      return options.local ? new FsBlobStore(m.dir, m.signer) : s3.store(m)
    },
  })
  ctx = c
  c.queue.start()
  const store = c.blobs as BucketBlobStore
  const capture = async (id: string) => {
    const job = submit(c, { url: `https://fake.test/p/${id}` })
    await c.queue.drain()
    return c.db.select().from(captures).where(eq(captures.id, job.id)).get()!
  }
  const route = mediaRoutes(store, signer, {
    sharedCache: true,
    regenerate: (key) => regenerateThumbnail(c, key),
  })
  return { c, clock, media, logs, store, capture, route }
}

const uploads = (c: CaptureContext) =>
  c.db.select().from(jobs).where(eq(jobs.type, 'upload')).all()

describe('media in R2', () => {
  test('a download is local first; once the upload is confirmed the web gets the public URL and the local original goes', async () => {
    const { c, media, store } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    let release!: () => void
    s3.gate = new Promise((resolve) => (release = resolve))
    const job = submit(c, { url: 'https://fake.test/p/1' })
    await vi.waitFor(() =>
      expect(
        c.db.select().from(captures).where(eq(captures.id, job.id)).get()
          ?.state,
      ).toBe('complete'),
    )
    const blob = c.db.select().from(blobs).get()!
    // Saved and shown from here while the upload waits.
    expect(await store.local.stat(blob.hash)).toBe(JPEG.length)
    expect(blob.remoteAt).toBeNull()
    const pending = getCollection(
      c,
      c.db.select().from(captures).get()!.collectionId,
    ).assets[0]!
    expect(pending.url).toMatch(new RegExp(String.raw`^/media/${blob.hash}\?`))
    expect(s3.objects.size).toBe(0)

    release()
    s3.gate = undefined
    await c.queue.drain()
    const uploaded = c.db.select().from(blobs).get()!
    expect(uploaded.remoteAt).toBeInstanceOf(Date)
    const object = s3.objects.get(objectPath(blob.hash))!
    expect(object).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE,
    })
    const view = getCollection(
      c,
      c.db.select().from(captures).get()!.collectionId,
    ).assets[0]!
    expect(view.url).toBe(`${FAKE_PUBLIC}/${objectPath(blob.hash)}`)
    // Downloads keep their name, so they go through the server.
    expect(view.download_url).toMatch(
      new RegExp(String.raw`^/media/${blob.hash}\?`),
    )
    // The bucket has the only copy now, and reads go there.
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(await buffer(await store.read(blob.hash))).toEqual(JPEG)
    expect(uploads(c)).toEqual([])
  })

  test('a failed upload is retried later and logged; the media stays local meanwhile', async () => {
    const { c, clock, media, logs, store, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    // Every try of the request.
    s3.failNext = S3_ATTEMPTS
    const done = await capture('1')
    expect(done.state).toBe('complete')
    const { hash } = c.db.select().from(blobs).get()!
    expect(c.db.select().from(blobs).get()!.remoteAt).toBeNull()
    expect(await store.local.stat(hash)).toBe(JPEG.length)
    const waiting = c.db
      .select()
      .from(jobs)
      .where(eq(jobs.type, 'upload'))
      .get()!
    expect(waiting).toMatchObject({ attempt: 1, maxAttempts: 12 })
    expect(waiting.runAt.getTime() - clock.now).toBe(30_000)
    expect(logs.entries).toContainEqual(
      expect.objectContaining({ msg: 'job will retry', jobType: 'upload' }),
    )
    clock.now += 31_000
    await c.queue.drain()
    expect(c.db.select().from(blobs).get()!.remoteAt).toBeInstanceOf(Date)
    expect(await store.local.stat(hash)).toBeUndefined()
    expect(c.db.select().from(jobs).all()).toEqual([])
  })

  test('an upload that reads back wrong is not recorded, and the local file stays', async () => {
    const { c, clock, media, store, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    s3.overwrite = { cacheControl: 'no-store' }
    await capture('1')
    const blob = c.db.select().from(blobs).get()!
    expect(blob.remoteAt).toBeNull()
    expect(await store.local.stat(blob.hash)).toBe(JPEG.length)
    const waiting = uploads(c)[0]!
    expect(waiting).toMatchObject({ type: 'upload', attempt: 1 })
    expect(waiting.lastError).toMatch(
      /reads back wrong: Cache-Control no-store/,
    )

    s3.overwrite = undefined
    clock.now += 31_000
    await c.queue.drain()
    expect(c.db.select().from(blobs).get()!.remoteAt).toBeInstanceOf(Date)
    expect(await store.local.stat(blob.hash)).toBeUndefined()
  })

  test('a failed deletion of the local copy is retried; the blob stays recorded in the bucket', async () => {
    const { c, clock, media, logs, store, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    const deleteLocal = vi
      .spyOn(store, 'deleteLocal')
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
    await capture('1')
    const blob = c.db.select().from(blobs).get()!
    expect(blob.remoteAt).toBeInstanceOf(Date)
    expect(await store.local.stat(blob.hash)).toBe(JPEG.length)
    const waiting = uploads(c)[0]!
    expect(waiting).toMatchObject({ type: 'upload', attempt: 1 })
    expect(waiting.runAt.getTime() - clock.now).toBe(30_000)
    expect(logs.entries).toContainEqual(
      expect.objectContaining({ msg: 'job will retry', jobType: 'upload' }),
    )
    // Recorded once; the retry only deletes.
    const puts = s3.requests.filter((r) => r.method === 'PUT').length
    clock.now += 31_000
    await c.queue.drain()
    expect(deleteLocal).toHaveBeenCalledTimes(2)
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(c.db.select().from(blobs).get()!.remoteAt).toEqual(blob.remoteAt)
    expect(s3.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts)
  })

  test('the thumbnail is rendered from the local file before the file goes', async () => {
    const ffmpeg = fakeFfmpeg()
    const { c, media, store } = setup({ thumbnailer: ffmpeg.thumbnailer })
    media['1'] = [
      { url: 'https://m.test/v.mp4', kind: 'video', immutableKey: 'x:v:1' },
    ]
    // ffmpeg has its path but has not opened it when the upload is confirmed.
    ffmpeg.hold()
    submit(c, { url: 'https://fake.test/p/1' })
    await vi.waitFor(() => {
      expect(ffmpeg.calls()).toHaveLength(1)
      expect(c.db.select().from(blobs).get()?.remoteAt).toBeInstanceOf(Date)
    })
    const blob = c.db.select().from(blobs).get()!
    await vi.waitFor(async () => expect(uploads(c)).toEqual([]))
    expect(await store.local.stat(blob.hash)).toBe(VIDEO.length)

    ffmpeg.release()
    await c.queue.drain()
    const thumbnail = c.db.select().from(blobThumbnails).get()!
    expect(thumbnail.state).toBe('ready')
    const input = ffmpeg.calls()[0]!
    expect(input[input.indexOf('-i') + 1]).toBe(store.local.path(blob.hash))
    // Then the original went; the thumbnail stays local.
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(await store.local.stat(thumbnail.key!)).toBe(thumbnail.size)
    expect(s3.requests.some((r) => r.presigned)).toBe(false)
  })

  test('a read open while the local copy goes keeps reading it; later reads use the bucket', async () => {
    const { c, media, store } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    let release!: () => void
    s3.gate = new Promise((resolve) => (release = resolve))
    const job = submit(c, { url: 'https://fake.test/p/1' })
    await vi.waitFor(() =>
      expect(
        c.db.select().from(captures).where(eq(captures.id, job.id)).get()
          ?.state,
      ).toBe('complete'),
    )
    const { hash } = c.db.select().from(blobs).get()!
    // What a Telegram send hands grammY's InputFile to read.
    const sending = await c.blobs.read(hash)
    release()
    s3.gate = undefined
    await c.queue.drain()
    expect(await store.local.stat(hash)).toBeUndefined()
    expect(s3.requests.filter((r) => r.method === 'GET')).toEqual([])
    expect(await buffer(sending)).toEqual(JPEG)

    expect(await buffer(await c.blobs.read(hash))).toEqual(JPEG)
    expect(
      s3.requests.filter((r) => r.method === 'GET' && !r.presigned),
    ).toHaveLength(1)
  })

  test('downloading bytes already in the bucket writes no local copy', async () => {
    const { c, media, store, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    media['2'] = [{ url: 'https://m.test/a.jpg?copy' }]
    await capture('1')
    const blob = c.db.select().from(blobs).get()!
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    const done = await capture('2')
    expect(done.state).toBe('complete')
    expect(c.db.select().from(blobs).all()).toHaveLength(1)
    expect(
      c.db.select().from(assets).where(eq(assets.captureId, done.id)).get()!
        .blobId,
    ).toBe(blob.id)
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(uploads(c)).toEqual([])
  })

  test('collecting an unreferenced blob deletes its object and purges its URL', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    const done = await capture('1')
    const blob = c.db.select().from(blobs).get()!
    const key = objectPath(blob.hash)
    expect(s3.objects.has(key)).toBe(true)
    deleteCollection(c.db, done.collectionId)
    await collectCollections(c)
    expect(c.db.select().from(blobs).all()).toEqual([])
    // The grace period first.
    await collectMedia(c)
    expect(s3.objects.has(key)).toBe(true)
    clock.now += 25 * HOUR
    expect(await collectMedia(c)).toBe(1)
    expect(s3.objects.has(key)).toBe(false)
    expect(s3.purged).toEqual([`${FAKE_PUBLIC}/${key}`])
    expect(await c.blobs.stat(blob.hash)).toBeUndefined()
  })

  test('删除媒体 deletes the object and purges its URL', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [
      { url: 'https://m.test/v.mp4', kind: 'video', immutableKey: 'x:v:1' },
    ]
    const done = await capture('1')
    const blob = c.db.select().from(blobs).get()!
    const key = objectPath(blob.hash)
    const asset = c.db.select().from(assets).get()!
    removeMedia(c, { collection: done.collectionId, asset: asset.id })
    clock.now += 25 * HOUR
    await collectMedia(c)
    expect(s3.objects.has(key)).toBe(false)
    expect(s3.purged).toEqual([`${FAKE_PUBLIC}/${key}`])
  })

  test('a lost thumbnail is rendered again from the original in R2, video by byte ranges', async () => {
    const ffmpeg = fakeFfmpeg()
    const { c, media, store, route } = setup({
      thumbnailer: ffmpeg.thumbnailer,
    })
    media['1'] = [
      { url: 'https://m.test/v.mp4', kind: 'video', immutableKey: 'x:v:1' },
    ]
    const done = await capture()
    async function capture() {
      const job = submit(c, { url: 'https://fake.test/p/1' })
      await c.queue.drain()
      return c.db.select().from(captures).where(eq(captures.id, job.id)).get()!
    }
    const blob = c.db.select().from(blobs).get()!
    const thumbnail = c.db.select().from(blobThumbnails).get()!
    expect(thumbnail.state).toBe('ready')
    // Rendered from the local file at download time.
    expect(ffmpeg.calls()[0]).toContain(store.local.path(blob.hash))
    expect(blob.remoteAt).toBeInstanceOf(Date)
    // The thumbnail was never uploaded.
    expect(s3.objects.has(objectPath(thumbnail.key!))).toBe(false)

    // The local original went after the upload; now the thumbnail goes too.
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    await rm(store.local.path(thumbnail.key!))
    const url = getCollection(c, done.collectionId).assets[0]!.thumbnail_url!
    s3.requests.length = 0
    const response = await route.request(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.subarray(4).equals(VIDEO.subarray(0, 16))).toBe(true)
    const input = ffmpeg.calls().at(-1)!
    const source = input[input.indexOf('-i') + 1]!
    expect(source).toMatch(/^http:.*X-Amz-Signature=/)
    // Only ranges of the video were read, through the presigned URL.
    const reads = s3.requests.filter((r) => r.method === 'GET')
    expect(reads.map((r) => [r.range, r.presigned])).toEqual([
      ['bytes=0-15', true],
      ['bytes=-4', true],
    ])
    expect(await store.local.stat(thumbnail.key!)).toBe(bytes.length)

    // A different ffmpeg renders other bytes: recorded under their own key.
    ffmpeg.setVersion('2')
    await rm(store.local.path(thumbnail.key!))
    const moved = await route.request(url)
    expect(moved.status).toBe(307)
    const now = c.db.select().from(blobThumbnails).get()!
    expect(now.key).not.toBe(thumbnail.key)
    expect(moved.headers.get('location')).toMatch(
      new RegExp(String.raw`^/media/${now.key}\?`),
    )
    const followed = await route.request(moved.headers.get('location')!)
    expect(followed.status).toBe(200)
    expect(getCollection(c, done.collectionId).assets[0]!.thumbnail_url).toBe(
      moved.headers.get('location'),
    )
  })

  test('a missing key that is no thumbnail stays missing', async () => {
    const { route, store } = setup({ thumbnailer: fakeFfmpeg().thumbnailer })
    const key = 'a'.repeat(64)
    const response = await route.request(
      store.url(key, { contentType: 'image/jpeg' }),
    )
    expect(response.status).toBe(404)
  })
})

describe('media in the local directory only', () => {
  test('nothing is uploaded and the local original stays', async () => {
    const ffmpeg = fakeFfmpeg()
    const { c, media, capture } = setup({
      local: true,
      thumbnailer: ffmpeg.thumbnailer,
    })
    media['1'] = [
      { url: 'https://m.test/v.mp4', kind: 'video', immutableKey: 'x:v:1' },
    ]
    media['2'] = [{ url: 'https://m.test/a.jpg' }]
    media['3'] = [{ url: 'https://m.test/a.jpg?copy' }]
    for (const id of ['1', '2', '3'])
      expect((await capture(id)).state).toBe('complete')
    const all = c.db.select().from(blobs).all()
    expect(all).toHaveLength(2)
    for (const blob of all) {
      expect(blob.remoteAt).toBeNull()
      expect(await c.blobs.stat(blob.hash)).toBe(blob.size)
    }
    expect(c.blobs.deleteLocal).toBeUndefined()
    expect(c.db.select().from(blobThumbnails).all()).toHaveLength(2)
    expect(uploads(c)).toEqual([])
    expect(s3.requests).toEqual([])
  })
})
