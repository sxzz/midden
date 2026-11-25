import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { newId } from '#db/id.ts'
import { blobs, blobThumbnails } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { FAKE_PUBLIC, FakeS3 } from '#testing/fake-s3.ts'
import { mediaCommand, migrateMedia, pruneLocalMedia } from './migrate.ts'
import { IMMUTABLE, objectPath } from './store.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { BucketBlobStore } from './bucket-store.ts'

let s3: FakeS3
let ctx: CaptureContext
let store: BucketBlobStore
let lines: string[]
const print = (line: string) => lines.push(line)

beforeEach(async () => {
  s3 = await new FakeS3().start()
  ctx = testContext({ blobs: (m) => s3.store(m) })
  store = ctx.blobs as BucketBlobStore
  lines = []
})
afterEach(() => s3.stop())

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const md5 = (body: Buffer) => createHash('md5').update(body)

/** A blob with its local file, as a download leaves it. */
async function addBlob(
  text: string,
  options: { mime?: string; bytes?: Buffer } = {},
) {
  const body = Buffer.from(text)
  const hash = sha256(body)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'blob-')), 'f')
  writeFileSync(file, options.bytes ?? body)
  await store.putFile(hash, file)
  const id = newId()
  ctx.db
    .insert(blobs)
    .values({ id, hash, size: body.length, mime: options.mime ?? 'image/jpeg' })
    .run()
  return { id, hash, body, key: objectPath(hash) }
}

const remoteAt = (id: string) =>
  ctx.db.select().from(blobs).where(eq(blobs.id, id)).get()!.remoteAt
const writes = () =>
  s3.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE')

describe('media-migrate', () => {
  test('a dry run reads and reports, and writes nothing', async () => {
    const a = await addBlob('a')
    const b = await addBlob('b')
    const summary = await migrateMedia(ctx.db, store, { dryRun: true, print })
    expect(summary).toMatchObject({
      blobs: 2,
      uploaded: 2,
      marked: 2,
      localDeleted: 2,
      localBytes: 2,
    })
    expect(writes()).toEqual([])
    expect(remoteAt(a.id)).toBeNull()
    for (const blob of [a, b]) expect(await store.local.stat(blob.hash)).toBe(1)
    expect(lines[0]).toBe('[dry run] 2 blobs not yet in the bucket')
    expect(
      await mediaCommand('media-migrate', ctx.db, store, {
        dryRun: true,
        print,
      }),
    ).toBe(0)
    expect(lines.at(-1)).toContain('would delete 2 local files (2 B)')
  })

  test('uploads with the right headers, records each blob, deletes its local file, and finds nothing left after', async () => {
    const a = await addBlob('a', { mime: 'video/mp4' })
    const b = await addBlob('b')
    const summary = await migrateMedia(ctx.db, store, { print })
    expect(summary).toMatchObject({
      blobs: 2,
      uploaded: 2,
      marked: 2,
      failed: 0,
      bytesUploaded: 2,
      localDeleted: 2,
      localBytes: 2,
    })
    expect(s3.objects.get(a.key)).toMatchObject({
      contentType: 'video/mp4',
      cacheControl: IMMUTABLE,
    })
    expect(s3.objects.get(b.key)!.body.equals(b.body)).toBe(true)
    expect(remoteAt(a.id)).toBeInstanceOf(Date)
    // The bucket has the only copy now.
    for (const blob of [a, b]) {
      expect(await store.local.stat(blob.hash)).toBeUndefined()
      expect(await store.stat(blob.hash)).toBe(1)
    }
    s3.requests.length = 0
    expect(await migrateMedia(ctx.db, store, { print })).toMatchObject({
      blobs: 0,
    })
    expect(s3.requests).toEqual([])
  })

  test('resumes after an interruption without uploading twice', async () => {
    const a = await addBlob('a')
    const b = await addBlob('b')
    const c = await addBlob('c')
    // An earlier run uploaded `a` and stopped before recording it.
    s3.seed(a.key, a.body, {
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE,
    })
    // The bucket fails on `b` for now.
    s3.failKeys.add(b.key)
    const first = await migrateMedia(ctx.db, store, { print })
    expect(first).toMatchObject({
      blobs: 3,
      uploaded: 1,
      present: { etag: 1 },
      marked: 2,
      failed: 1,
    })
    expect(lines).toContain(`failed ${b.hash}: S3 HeadObject failed: 500`)
    expect(remoteAt(b.id)).toBeNull()
    s3.failKeys.clear()
    s3.requests.length = 0
    const second = await migrateMedia(ctx.db, store, { print })
    expect(second).toMatchObject({ blobs: 1, uploaded: 1, failed: 0 })
    for (const blob of [a, b, c]) expect(remoteAt(blob.id)).toBeInstanceOf(Date)
    // Only `b` was touched the second time; `a` was never uploaded again.
    expect(new Set(s3.requests.map((r) => r.key))).toEqual(new Set([b.key]))
    expect(s3.objects.get(a.key)!.body.equals(a.body)).toBe(true)
  })

  test('the command prints a summary with a URL to check by hand', async () => {
    const a = await addBlob('a')
    expect(await mediaCommand('media-migrate', ctx.db, store, { print })).toBe(
      0,
    )
    expect(lines.at(-1)).toBe(
      [
        'checked 1 blobs',
        'uploaded 1 (1 B), replaced 0',
        'already in the bucket 0, headers fixed 0',
        `recorded in the bucket 1, e.g. ${FAKE_PUBLIC}/${a.key}`,
        'deleted 1 local files (1 B), kept 0 for thumbnails',
        'missing locally 0, hash mismatch 0, failed 0',
      ].join('\n'),
    )
  })

  test('keeps the local file of a blob whose thumbnail is still to be made, or that is a thumbnail', async () => {
    const due = await addBlob('due')
    const thumbnail = await addBlob('thumbnail')
    const plain = await addBlob('plain')
    ctx.queue.enqueue(ctx.db, 'thumbnail', due.id)
    ctx.db
      .insert(blobThumbnails)
      .values({
        blobId: plain.id,
        state: 'ready',
        key: thumbnail.hash,
        size: 1,
        mime: 'image/jpeg',
      })
      .run()
    const dry = await migrateMedia(ctx.db, store, { print, dryRun: true })
    expect(dry).toMatchObject({ localDeleted: 1, localKept: 2 })
    const summary = await migrateMedia(ctx.db, store, { print })
    expect(summary).toMatchObject({ marked: 3, localDeleted: 1, localKept: 2 })
    expect(await store.local.stat(plain.hash)).toBeUndefined()
    for (const kept of [due, thumbnail])
      expect(await store.local.stat(kept.hash)).toBe(kept.body.length)
    expect(remoteAt(due.id)).toBeInstanceOf(Date)
  })

  test('a blob the server uploads while it runs is no problem', async () => {
    const first = await addBlob('first')
    const second = await addBlob('second')
    let release!: () => void
    s3.gate = new Promise((resolve) => (release = resolve))
    const running = mediaCommand('media-migrate', ctx.db, store, {
      print,
      concurrency: 1,
    })
    await vi.waitFor(() =>
      expect(s3.requests.some((r) => r.method === 'PUT')).toBe(true),
    )
    // The server's upload job records `second` and deletes its local file.
    ctx.db
      .update(blobs)
      .set({ remoteAt: new Date() })
      .where(eq(blobs.id, second.id))
      .run()
    await store.deleteLocal(second.hash)
    release()
    s3.gate = undefined
    expect(await running).toBe(0)
    expect(remoteAt(first.id)).toBeInstanceOf(Date)
    expect(lines.at(-1)).toContain(
      'recorded in the bucket 1 (and 1 by the server meanwhile)',
    )
    expect(lines.at(-1)).toContain(
      'missing locally 0, hash mismatch 0, failed 0',
    )
  })

  test('a failed deletion of the local file keeps the record and counts as a failure', async () => {
    const a = await addBlob('a')
    vi.spyOn(store, 'deleteLocal').mockRejectedValueOnce(new Error('EBUSY'))
    expect(await mediaCommand('media-migrate', ctx.db, store, { print })).toBe(
      1,
    )
    expect(remoteAt(a.id)).toBeInstanceOf(Date)
    expect(await store.local.stat(a.hash)).toBe(1)
    expect(lines).toContain(
      `recorded, but deleting the local file failed: ${a.hash}: EBUSY`,
    )
    // media-prune-local takes it from there.
    expect(await pruneLocalMedia(ctx.db, store, { print })).toMatchObject({
      deleted: 1,
    })
    expect(await store.local.stat(a.hash)).toBeUndefined()
  })

  test('a local file that does not match its hash is reported, not uploaded', async () => {
    const a = await addBlob('a', { bytes: Buffer.from('z') })
    const summary = await migrateMedia(ctx.db, store, { print })
    expect(summary).toMatchObject({ hashMismatch: 1, uploaded: 0, marked: 0 })
    expect(s3.objects.size).toBe(0)
    expect(remoteAt(a.id)).toBeNull()
    expect(lines).toContain(`hash mismatch, not uploaded: ${a.hash}`)
    expect(await mediaCommand('media-migrate', ctx.db, store, { print })).toBe(
      1,
    )
  })

  test('objects copied by rclone are kept when a checksum checks out, and their headers fixed on the server', async () => {
    // One part: the ETag is the MD5. rclone set Cache-Control but not the type.
    const single = await addBlob('single', { mime: 'video/mp4' })
    s3.seed(single.key, single.body, {
      contentType: 'application/octet-stream',
      cacheControl: IMMUTABLE,
      metadata: { mtime: '1700000000' },
    })
    // Multipart: rclone records the MD5 in metadata.
    const multi = await addBlob('multi')
    s3.seed(multi.key, multi.body, {
      etag: 'abc-2',
      metadata: { md5chksum: md5(multi.body).digest('base64') },
    })
    // Corrupt: right size, wrong bytes.
    const corrupt = await addBlob('corrupt')
    s3.seed(corrupt.key, Buffer.from('CORRUPT'))
    // Truncated.
    const short = await addBlob('short')
    s3.seed(short.key, Buffer.from('sho'))
    // No checksum at all: its size alone is not enough.
    const bare = await addBlob('bare')
    s3.seed(bare.key, bare.body, { etag: 'def-3' })
    // A thumbnail rclone copied too: no blob names it.
    const thumbnail = Buffer.from('thumbnail')
    s3.seed(objectPath(sha256(thumbnail)), thumbnail)

    const summary = await migrateMedia(ctx.db, store, { print })
    expect(summary).toMatchObject({
      uploaded: 0,
      replaced: 3,
      present: { etag: 1, 'rclone-md5': 1, download: 0, sha256: 0 },
      headersFixed: 2,
      marked: 5,
      localDeleted: 5,
      failed: 0,
    })
    expect(lines).toContain(`replacing ${bare.hash}: no checksum to compare`)
    expect(lines).toContain(`replacing ${corrupt.hash}: content differs`)
    expect(lines).toContain(`replacing ${short.hash}: size 3, expected 5`)
    expect(s3.objects.get(bare.key)!.etag).toBe(md5(bare.body).digest('hex'))
    for (const blob of [single, multi, corrupt, short, bare])
      expect(s3.objects.get(blob.key)).toMatchObject({
        contentType: blob === single ? 'video/mp4' : 'image/jpeg',
        cacheControl: IMMUTABLE,
      })
    expect(s3.objects.get(corrupt.key)!.body.equals(corrupt.body)).toBe(true)
    expect(s3.objects.get(short.key)!.body.equals(short.body)).toBe(true)
    // Fixed by a copy onto itself; other metadata kept.
    const copies = s3.requests.filter((r) => r.headers['x-amz-copy-source'])
    expect(copies.map((r) => r.key).toSorted()).toEqual(
      [single.key, multi.key].toSorted(),
    )
    expect(
      copies.every((r) => r.headers['x-amz-metadata-directive'] === 'REPLACE'),
    ).toBe(true)
    expect(s3.objects.get(single.key)!.metadata).toEqual({
      mtime: '1700000000',
    })
    // Never touched.
    expect(
      s3.objects.get(objectPath(sha256(thumbnail)))!.contentType,
    ).toBeUndefined()
    expect(
      s3.requests.filter((r) => r.key === objectPath(sha256(thumbnail))),
    ).toEqual([])
  })

  test('--verify-download hashes objects that carry no checksum', async () => {
    const good = await addBlob('good')
    s3.seed(good.key, good.body, {
      etag: 'x-2',
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE,
    })
    const bad = await addBlob('bad!')
    s3.seed(bad.key, Buffer.from('BAD!'), { etag: 'y-2' })
    const summary = await migrateMedia(ctx.db, store, {
      print,
      verifyDownload: true,
    })
    expect(summary).toMatchObject({
      present: { download: 1 },
      replaced: 1,
      marked: 2,
    })
    expect(s3.objects.get(bad.key)!.body.toString()).toBe('bad!')
  })

  test('a blob missing locally counts only with a verified copy in the bucket', async () => {
    const gone = await addBlob('gone')
    await store.local.delete(gone.hash)
    expect(await migrateMedia(ctx.db, store, { print })).toMatchObject({
      missing: 1,
      marked: 0,
    })
    s3.seed(gone.key, gone.body)
    expect(await migrateMedia(ctx.db, store, { print })).toMatchObject({
      missing: 1,
      marked: 0,
    })
    expect(
      await migrateMedia(ctx.db, store, { print, verifyDownload: true }),
    ).toMatchObject({ missing: 0, marked: 1, present: { download: 1 } })
    expect(remoteAt(gone.id)).toBeInstanceOf(Date)
  })
})

describe('media-prune-local', () => {
  test('deletes only local originals confirmed in the bucket, and keeps thumbnails', async () => {
    const confirmed = await addBlob('confirmed')
    const pending = await addBlob('pending')
    const wrong = await addBlob('wrong')
    const bare = await addBlob('bare')
    const shared = await addBlob('also a thumbnail')
    const due = await addBlob('thumbnail due')
    // Recorded with their local files kept, as before local files went
    // with the upload.
    for (const blob of [confirmed, wrong, bare, shared, due]) {
      await store.upload(blob.hash, 'image/jpeg')
      ctx.db
        .update(blobs)
        .set({ remoteAt: new Date() })
        .where(eq(blobs.id, blob.id))
        .run()
    }
    ctx.queue.enqueue(ctx.db, 'thumbnail', due.id)
    // Changed in the bucket since: the ETag no longer matches.
    s3.objects.get(wrong.key)!.etag = '0'.repeat(32)
    // Without a checksum to compare.
    s3.objects.get(bare.key)!.etag = 'z-2'
    ctx.db
      .insert(blobThumbnails)
      .values({
        blobId: confirmed.id,
        state: 'ready',
        key: shared.hash,
        size: 1,
        mime: 'image/jpeg',
      })
      .run()

    const dry = await pruneLocalMedia(ctx.db, store, { dryRun: true, print })
    expect(dry).toMatchObject({
      deleted: 1,
      mismatched: 1,
      unverified: 1,
      thumbnails: 2,
    })
    expect(await store.local.stat(confirmed.hash)).toBeDefined()
    expect(remoteAt(wrong.id)).toBeInstanceOf(Date)

    const summary = await pruneLocalMedia(ctx.db, store, { print })
    expect(summary).toMatchObject({
      blobs: 5,
      deleted: 1,
      bytes: confirmed.body.length,
      mismatched: 1,
      unverified: 1,
      thumbnails: 2,
    })
    expect(await store.local.stat(confirmed.hash)).toBeUndefined()
    for (const kept of [pending, wrong, bare, shared, due])
      expect(await store.local.stat(kept.hash)).toBeDefined()
    // The wrong copy is no longer handed out; the next migration redoes it.
    expect(remoteAt(wrong.id)).toBeNull()
    // Still readable, now from the bucket.
    expect(await store.stat(confirmed.hash)).toBe(confirmed.body.length)

    expect(
      await pruneLocalMedia(ctx.db, store, { print, verifyDownload: true }),
    ).toMatchObject({ deleted: 1, absent: 1 })
    expect(await store.local.stat(bare.hash)).toBeUndefined()
  })
})
