import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  INCOMING,
  PART_BYTES,
  type BucketBlobStore,
} from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { mediaRoutes } from '#blob/route.ts'
import { S3_ATTEMPTS } from '#blob/s3.ts'
import { IMMUTABLE, objectPath } from '#blob/store.ts'
import { newId } from '#db/id.ts'
import { assets, blobs, blobThumbnails, captures, jobs } from '#db/schema.ts'
import { deleteCollection } from '#library/delete.ts'
import { removeMedia } from '#library/media-removal.ts'
import { getCollection } from '#library/read.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { FAKE_PUBLIC, FakeS3 } from '#testing/fake-s3.ts'
import { jpegOf } from '#testing/images.ts'
import { recordingLogger } from '#testing/logs.ts'
import { captureHandlers } from './handlers.ts'
import { collectCollections, collectMedia } from './maintenance.ts'
import { submit } from './submit.ts'
import { regenerateThumbnail } from './thumbnail.ts'
import { enqueueUpload } from './upload.ts'
import type { MediaSigner } from '#blob/signer.ts'
import type { Resource } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(200, 7),
])
const POSTER = jpegOf(400, 225, 'poster')
const SMALL = jpegOf(400, 300, 'small')
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
function setup(options: { local?: boolean } = {}) {
  const clock = { now: Date.now() }
  const media: Record<string, Partial<Resource>[]> = {}
  const files: Record<string, Buffer> = {
    'https://m.test/a.jpg': JPEG,
    'https://m.test/a.jpg?copy': JPEG,
    'https://m.test/v.mp4': VIDEO,
    'https://m.test/v.jpg': POSTER,
    'https://m.test/a-small.jpg': SMALL,
  }
  const logs = recordingLogger()
  let signer!: MediaSigner
  const c = testContext({
    now: () => clock.now,
    logger: logs.logger,
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
  return { c, clock, media, files, logs, store, capture, route }
}

/**
 * Lose every thumbnail's file, in the bucket too, as if it had stayed
 * local and the media directory went.
 */
function loseThumbnails(c: CaptureContext) {
  for (const row of c.db.select().from(blobThumbnails).all()) {
    s3.objects.delete(objectPath(row.key!))
    rmSync((c.blobs as BucketBlobStore).local.path(row.key!), { force: true })
  }
  c.db.update(blobThumbnails).set({ remoteAt: null }).run()
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')

/** A blob downloaded before downloads streamed into the bucket. */
async function legacyBlob(c: CaptureContext, bytes: Buffer) {
  const hash = sha256(bytes)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'legacy-')), 'f')
  writeFileSync(file, bytes)
  await (c.blobs as BucketBlobStore).local.putFile(hash, file)
  const id = newId()
  c.db
    .insert(blobs)
    .values({ id, hash, size: bytes.length, mime: 'image/jpeg' })
    .run()
  enqueueUpload(c, c.db, id)
  return { id, hash }
}

const remoteAt = (c: CaptureContext, id: string) =>
  c.db.select().from(blobs).where(eq(blobs.id, id)).get()!.remoteAt

const uploads = (c: CaptureContext) =>
  c.db.select().from(jobs).where(eq(jobs.type, 'upload')).all()

describe('media in R2', () => {
  test('a download streams into the bucket: recorded there from the start, with no local file and no upload', async () => {
    const { c, media, store, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    const done = await capture('1')
    expect(done.state).toBe('complete')
    const blob = c.db.select().from(blobs).get()!
    expect(blob.remoteAt).toBeInstanceOf(Date)
    expect(s3.objects.get(objectPath(blob.hash))).toMatchObject({
      body: JPEG,
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE,
    })
    // One PUT straight to the hash, checked by MD5 and SHA-256.
    const put = s3.requests.find((r) => r.method === 'PUT')!
    expect(put.key).toBe(objectPath(blob.hash))
    expect(put.headers['x-amz-content-sha256']).toBe(blob.hash)
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(uploads(c)).toEqual([])
    const view = getCollection(c, done.collectionId).assets[0]!
    expect(view.url).toBe(`${FAKE_PUBLIC}/${objectPath(blob.hash)}`)
    // Downloads keep their name, so they go through the server.
    expect(view.download_url).toMatch(
      new RegExp(String.raw`^/media/${blob.hash}\?`),
    )
    expect(await buffer(await store.read(blob.hash))).toEqual(JPEG)
  })

  test('a file larger than a part goes up in parts under a temporary key, then is copied to its hash', async () => {
    const { c, media, files, capture } = setup()
    const big = Buffer.concat([VIDEO, Buffer.alloc(PART_BYTES + 1234, 3)])
    files['https://m.test/big.mp4'] = big
    media['1'] = [
      { url: 'https://m.test/big.mp4', kind: 'video', immutableKey: 'x:v:9' },
    ]
    expect((await capture('1')).state).toBe('complete')
    const blob = c.db.select().from(blobs).get()!
    expect(blob).toMatchObject({ hash: sha256(big), size: big.length })
    expect(blob.remoteAt).toBeInstanceOf(Date)
    expect(s3.objects.get(objectPath(blob.hash))).toMatchObject({
      body: big,
      contentType: 'video/mp4',
      cacheControl: IMMUTABLE,
      metadata: { sha256: blob.hash },
    })
    // The temporary object and the upload are gone.
    expect([...s3.objects.keys()]).toEqual([objectPath(blob.hash)])
    expect(s3.uploads.size).toBe(0)
    const parts = s3.requests.filter(
      (r) => r.method === 'PUT' && r.key.startsWith(`${INCOMING}/`),
    )
    expect(parts).toHaveLength(2)

    // The same bytes again: kept as they are, nothing copied.
    files['https://m.test/big.mp4?again'] = big
    media['2'] = [{ url: 'https://m.test/big.mp4?again', kind: 'video' }]
    s3.requests.length = 0
    expect((await capture('2')).state).toBe('complete')
    expect(s3.requests.filter((r) => r.headers['x-amz-copy-source'])).toEqual(
      [],
    )
    expect([...s3.objects.keys()]).toEqual([objectPath(blob.hash)])
    expect(c.db.select().from(blobs).all()).toHaveLength(1)
  })

  test('a download cut off midway leaves nothing behind, and the job tries again', async () => {
    const { c, clock, media, files, logs, capture } = setup()
    const big = Buffer.concat([VIDEO, Buffer.alloc(PART_BYTES + 10, 4)])
    let cut = true
    media['1'] = [{ url: 'https://m.test/cut.mp4', kind: 'video' }]
    files['https://m.test/cut.mp4'] = big
    c.fetch = async (input) => {
      const body = files[String(input)]!
      if (!cut) return new Response(body)
      // A first part, then the connection drops.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(body.subarray(0, PART_BYTES + 5))
          controller.error(new Error('connection reset'))
        },
      })
      return new Response(stream)
    }
    const done = await capture('1')
    expect(done.state).not.toBe('complete')
    expect(s3.objects.size).toBe(0)
    expect(s3.uploads.size).toBe(0)
    expect(logs.entries).toContainEqual(
      expect.objectContaining({ msg: 'job will retry', jobType: 'download' }),
    )
    cut = false
    clock.now += 60_000
    await c.queue.drain()
    expect(c.db.select().from(assets).get()!.state).toBe('ready')
    expect([...s3.objects.keys()]).toHaveLength(1)
  })

  test('a write to the bucket that keeps failing, or reads back wrong, fails the attempt; the retry writes it', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [{ url: 'https://m.test/a.jpg' }]
    // Every try of the one request.
    s3.failNext = S3_ATTEMPTS
    await capture('1')
    expect(c.db.select().from(blobs).all()).toEqual([])
    expect(c.db.select().from(assets).get()!.state).toBe('pending')
    s3.overwrite = { cacheControl: 'no-store' }
    clock.now += 60_000
    await c.queue.drain()
    expect(c.db.select().from(blobs).all()).toEqual([])
    expect(c.db.select().from(jobs).get()!.lastError).toMatch(
      /reads back wrong: Cache-Control no-store/,
    )
    s3.overwrite = undefined
    clock.now += 60_000
    await c.queue.drain()
    expect(c.db.select().from(blobs).get()!.remoteAt).toBeInstanceOf(Date)
  })

  test('a local original from before is uploaded by its job, then its local copy goes; a failed deletion is retried', async () => {
    const { c, clock, logs, store } = setup()
    const blob = await legacyBlob(c, JPEG)
    const deleteLocal = vi
      .spyOn(store, 'deleteLocal')
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
    await c.queue.drain()
    expect(remoteAt(c, blob.id)).toBeInstanceOf(Date)
    expect(await store.local.stat(blob.hash)).toBe(JPEG.length)
    const waiting = uploads(c)[0]!
    expect(waiting).toMatchObject({ type: 'upload', attempt: 1 })
    expect(waiting.runAt.getTime() - clock.now).toBe(30_000)
    expect(logs.entries).toContainEqual(
      expect.objectContaining({ msg: 'job will retry', jobType: 'upload' }),
    )
    const puts = s3.requests.filter((r) => r.method === 'PUT').length
    clock.now += 31_000
    await c.queue.drain()
    expect(deleteLocal).toHaveBeenCalledTimes(2)
    expect(await store.local.stat(blob.hash)).toBeUndefined()
    expect(s3.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts)
    expect(uploads(c)).toEqual([])
  })

  test('the poster of a video is its thumbnail, streamed into the bucket as the original is', async () => {
    const { c, media, store, capture } = setup()
    media['1'] = [
      {
        url: 'https://m.test/v.mp4',
        kind: 'video',
        immutableKey: 'x:v:1',
        width: 1920,
        height: 1080,
        thumbnailUrl: 'https://m.test/v.jpg',
      },
    ]
    const done = await capture('1')
    expect(done.state).toBe('complete')
    const thumbnail = c.db.select().from(blobThumbnails).get()!
    expect(thumbnail).toMatchObject({
      state: 'ready',
      mime: 'image/jpeg',
      size: POSTER.length,
      width: 400,
      height: 225,
    })
    expect(thumbnail.remoteAt).toBeInstanceOf(Date)
    expect(await store.local.stat(thumbnail.key!)).toBeUndefined()
    expect(s3.objects.get(objectPath(thumbnail.key!))).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE,
    })
    // Served from the bucket's public address, as originals are.
    expect(getCollection(c, done.collectionId).assets[0]!.thumbnail_url).toBe(
      `${FAKE_PUBLIC}/${objectPath(thumbnail.key!)}`,
    )
  })

  test('a read open while a local copy from before goes keeps reading it; later reads use the bucket', async () => {
    const { c, store } = setup()
    let release!: () => void
    s3.gate = new Promise((resolve) => (release = resolve))
    const { hash } = await legacyBlob(c, JPEG)
    // What a Telegram send hands grammY's InputFile to read.
    const sending = await c.blobs.read(hash)
    release()
    s3.gate = undefined
    await c.queue.drain()
    expect(await store.local.stat(hash)).toBeUndefined()
    expect(s3.requests.filter((r) => r.method === 'GET')).toEqual([])
    expect(await buffer(sending)).toEqual(JPEG)
    expect(await buffer(await c.blobs.read(hash))).toEqual(JPEG)
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

  test('a lost thumbnail is fetched again from the platform, under a new key if its bytes changed', async () => {
    const { c, media, files, route, capture } = setup()
    media['1'] = [
      {
        url: 'https://m.test/v.mp4',
        kind: 'video',
        immutableKey: 'x:v:1',
        thumbnailUrl: 'https://m.test/v.jpg',
      },
    ]
    const done = await capture('1')
    const thumbnail = c.db.select().from(blobThumbnails).get()!
    loseThumbnails(c)
    const url = getCollection(c, done.collectionId).assets[0]!.thumbnail_url!
    const response = await route.request(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(POSTER)
    // Back in the bucket.
    expect(s3.objects.has(objectPath(thumbnail.key!))).toBe(true)
    expect(c.db.select().from(blobThumbnails).get()!.remoteAt).toBeInstanceOf(
      Date,
    )

    // The platform sends other bytes now: recorded under their own key.
    const other = jpegOf(400, 225, 'poster, again')
    files['https://m.test/v.jpg'] = other
    loseThumbnails(c)
    const moved = await route.request(url)
    expect(moved.status).toBe(307)
    const now = c.db.select().from(blobThumbnails).get()!
    expect(now).toMatchObject({ size: other.length, width: 400 })
    expect(now.key).not.toBe(thumbnail.key)
    expect(moved.headers.get('location')).toMatch(
      new RegExp(String.raw`^/media/${now.key}\?`),
    )
    const followed = await route.request(moved.headers.get('location')!)
    expect(followed.status).toBe(200)
    expect(getCollection(c, done.collectionId).assets[0]!.thumbnail_url).toBe(
      `${FAKE_PUBLIC}/${objectPath(now.key!)}`,
    )
  })

  test('a lost image thumbnail the platform no longer serves stands in by its original; a lost video thumbnail does not', async () => {
    const { c, media, files, route, capture } = setup()
    media['1'] = [
      {
        url: 'https://m.test/a.jpg',
        thumbnailUrl: 'https://m.test/a-small.jpg',
      },
      {
        url: 'https://m.test/v.mp4',
        kind: 'video',
        immutableKey: 'x:v:1',
        thumbnailUrl: 'https://m.test/v.jpg',
      },
    ]
    const done = await capture('1')
    delete files['https://m.test/a-small.jpg']
    delete files['https://m.test/v.jpg']
    loseThumbnails(c)
    const [image, video] = getCollection(c, done.collectionId).assets
    const original = await route.request(image!.thumbnail_url!)
    expect(original.status).toBe(307)
    expect(original.headers.get('location')).toMatch(
      new RegExp(String.raw`^/media/${image!.sha256}\?`),
    )
    const followed = await route.request(original.headers.get('location')!)
    expect(Buffer.from(await followed.arrayBuffer())).toEqual(JPEG)
    expect((await route.request(video!.thumbnail_url!)).status).toBe(404)
  })

  test('a missing key that is no thumbnail stays missing', async () => {
    const { route, store } = setup()
    const key = 'a'.repeat(64)
    const response = await route.request(
      store.url(key, { contentType: 'image/jpeg' }),
    )
    expect(response.status).toBe(404)
  })
})

describe('media in the local directory only', () => {
  test('nothing is uploaded and the local original stays', async () => {
    const { c, media, capture } = setup({ local: true })
    media['1'] = [
      {
        url: 'https://m.test/v.mp4',
        kind: 'video',
        immutableKey: 'x:v:1',
        thumbnailUrl: 'https://m.test/v.jpg',
      },
    ]
    media['2'] = [
      {
        url: 'https://m.test/a.jpg',
        thumbnailUrl: 'https://m.test/a-small.jpg',
      },
    ]
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
