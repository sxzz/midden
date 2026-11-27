import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { localCopyHold } from '#blob/local-copy.ts'
import { IMMUTABLE, objectPath } from '#blob/store.ts'
import { newId } from '#db/id.ts'
import { blobs, blobThumbnails, removedMedia } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { FakeS3 } from '#testing/fake-s3.ts'
import { jpegOf } from '#testing/images.ts'
import { recordingLogger } from '#testing/logs.ts'
import { localUsage } from '#usage/local.ts'
import { moveThumbnails } from './thumbnail-remote.ts'
import type { BucketBlobStore } from '#blob/bucket-store.ts'
import type { CaptureContext } from './context.ts'

let s3: FakeS3
let ctx: CaptureContext
let store: BucketBlobStore
let clock: { now: number }
let logs: ReturnType<typeof recordingLogger>
beforeEach(async () => {
  s3 = await new FakeS3().start()
  clock = { now: Date.now() }
  logs = recordingLogger()
  ctx = testContext({
    now: () => clock.now,
    logger: logs.logger,
    blobs: (m) => s3.store(m),
  })
  store = ctx.blobs as BucketBlobStore
})
afterEach(async () => {
  await ctx.queue.stop()
  await s3.stop()
})

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')

async function putLocal(bytes: Buffer): Promise<string> {
  const key = sha256(bytes)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'thumb-')), 'f')
  writeFileSync(file, bytes)
  await store.putFile(key, file)
  return key
}

/** A blob with a thumbnail made before thumbnails moved to the bucket. */
async function legacy(name: string, options: { local?: boolean } = {}) {
  const original = Buffer.from(`original ${name}`)
  const thumbnail = jpegOf(400, 300, name)
  const blobId = newId()
  ctx.db
    .insert(blobs)
    .values({
      id: blobId,
      hash: sha256(original),
      size: original.length,
      mime: 'image/jpeg',
      remoteAt: new Date(),
    })
    .run()
  const key =
    options.local === false ? sha256(thumbnail) : await putLocal(thumbnail)
  ctx.db
    .insert(blobThumbnails)
    .values({
      blobId,
      state: 'ready',
      key,
      mime: 'image/webp',
      size: thumbnail.length,
    })
    .run()
  return { blobId, key, bytes: thumbnail }
}

const row = (blobId: string) =>
  ctx.db
    .select()
    .from(blobThumbnails)
    .where(eq(blobThumbnails.blobId, blobId))
    .get()!
/** Uploads of bytes; a copy onto itself (new headers) is a PUT too. */
const puts = () =>
  s3.requests.filter(
    (r) => r.method === 'PUT' && !r.headers['x-amz-copy-source'],
  )

describe('moving thumbnails to the bucket', () => {
  test('uploads each local one, confirms it, records it and deletes the local file', async () => {
    const a = await legacy('a')
    const b = await legacy('b')
    // A removed media item's thumbnail, whose blob is gone.
    const kept = jpegOf(400, 300, 'kept')
    const keptKey = await putLocal(kept)
    ctx.db
      .insert(removedMedia)
      .values({
        mediaKey: 'm1',
        kind: 'image',
        thumbnailKey: keptKey,
        thumbnailMime: 'image/jpeg',
        thumbnailSize: kept.length,
      })
      .run()
    expect((await localUsage(usageOptions())).thumbnails).toEqual({
      count: 3,
      bytes: a.bytes.length + b.bytes.length + kept.length,
      local_count: 3,
      local_bytes: a.bytes.length + b.bytes.length + kept.length,
    })

    expect(await moveThumbnails(ctx)).toBe(3)
    for (const { blobId, key, bytes } of [a, b]) {
      expect(row(blobId).remoteAt).toBeInstanceOf(Date)
      expect(await store.local.stat(key)).toBeUndefined()
      expect(s3.objects.get(objectPath(key))).toMatchObject({
        body: bytes,
        contentType: 'image/webp',
        cacheControl: IMMUTABLE,
      })
    }
    expect(
      ctx.db.select().from(removedMedia).get()!.thumbnailRemoteAt,
    ).toBeInstanceOf(Date)
    expect(await store.local.stat(keptKey)).toBeUndefined()
    expect((await localUsage(usageOptions())).thumbnails).toMatchObject({
      count: 3,
      local_count: 0,
      local_bytes: 0,
    })
    // Nothing left: the next pass reads nothing.
    s3.requests.length = 0
    expect(await moveThumbnails(ctx)).toBe(0)
    expect(s3.requests).toEqual([])
  })

  test('keeps an object already in the bucket with the same bytes, fixing its headers', async () => {
    const a = await legacy('a')
    // Copied by rclone before: no Cache-Control, a guessed Content-Type.
    s3.seed(objectPath(a.key), a.bytes, {
      contentType: 'application/octet-stream',
    })
    // And one whose object holds other bytes is uploaded over.
    const b = await legacy('b')
    s3.seed(objectPath(b.key), Buffer.from('something else'))
    expect(await moveThumbnails(ctx)).toBe(2)
    expect(puts().map((r) => r.key)).toEqual([objectPath(b.key)])
    expect(s3.objects.get(objectPath(a.key))).toMatchObject({
      body: a.bytes,
      contentType: 'image/webp',
      cacheControl: IMMUTABLE,
    })
    expect(s3.objects.get(objectPath(b.key))!.body).toEqual(b.bytes)
    expect(row(a.blobId).remoteAt).toBeInstanceOf(Date)
  })

  test('a thumbnail lost locally counts as moved when the bucket holds its bytes; one lost everywhere waits for the next sweep', async () => {
    const stray = await legacy('stray', { local: false })
    s3.seed(objectPath(stray.key), stray.bytes)
    const lost = await legacy('lost', { local: false })
    expect(await moveThumbnails(ctx)).toBe(1)
    expect(row(stray.blobId).remoteAt).toBeInstanceOf(Date)
    expect(puts()).toEqual([])
    expect(row(lost.blobId).remoteAt).toBeNull()
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        msg: 'moving a thumbnail to the remote store failed',
        key: lost.key,
        missing: true,
      }),
    )
    // Not read again until an hour after the sweep.
    s3.requests.length = 0
    expect(await moveThumbnails(ctx)).toBe(0)
    expect(s3.requests).toEqual([])
    await putLocal(lost.bytes)
    clock.now += 61 * 60_000
    expect(await moveThumbnails(ctx)).toBe(1)
    expect(row(lost.blobId).remoteAt).toBeInstanceOf(Date)
  })

  test('stops when the worker has other work', async () => {
    await legacy('a')
    expect(await moveThumbnails(ctx, () => false)).toBe(0)
    expect(s3.requests).toEqual([])
  })

  test('an original that is also a thumbnail keeps its local file only until the thumbnail moves', async () => {
    const a = await legacy('a')
    // The same bytes are also an uploaded original's.
    const shared = { id: newId(), hash: a.key }
    ctx.db
      .insert(blobs)
      .values({
        ...shared,
        size: a.bytes.length,
        mime: 'image/jpeg',
        remoteAt: new Date(),
      })
      .run()
    expect(localCopyHold(ctx.db, shared)).toBe('thumbnail')
    await moveThumbnails(ctx)
    expect(localCopyHold(ctx.db, shared)).toBeUndefined()
    expect(await store.local.stat(a.key)).toBeUndefined()

    // Not yet uploaded as an original: its upload job still reads the file.
    const b = await legacy('b')
    ctx.db
      .insert(blobs)
      .values({
        id: newId(),
        hash: b.key,
        size: b.bytes.length,
        mime: 'image/jpeg',
      })
      .run()
    clock.now += 61 * 60_000
    await moveThumbnails(ctx)
    expect(row(b.blobId).remoteAt).toBeInstanceOf(Date)
    expect(await store.local.stat(b.key)).toBe(b.bytes.length)
  })
})

function usageOptions() {
  return {
    db: ctx.db,
    dataDir: tmpdir(),
    databasePath: path.join(tmpdir(), 'none.db'),
  }
}
