import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FAKE_PUBLIC, FakeS3 } from '#testing/fake-s3.ts'
import { recordingLogger } from '#testing/logs.ts'
import { mediaRoutes } from './route.ts'
import { MediaSigner } from './signer.ts'
import { IMMUTABLE, objectPath } from './store.ts'
import type { BucketBlobStore } from './bucket-store.ts'

const BODY = Buffer.from('a media file, as bytes')
const KEY = createHash('sha256').update(BODY).digest('hex')

let s3: FakeS3
let store: BucketBlobStore
let dir: string
const signer = new MediaSigner({ secret: new TextEncoder().encode('test') })
const logger = pino({ level: 'silent' })

beforeEach(async () => {
  s3 = await new FakeS3().start()
  dir = mkdtempSync(path.join(tmpdir(), 'bucket-store-'))
  store = s3.store({ dir: path.join(dir, 'media'), signer, logger })
})
afterEach(() => s3.stop())

async function putLocal(body = BODY, key = KEY) {
  const file = path.join(dir, `staged-${key}`)
  writeFileSync(file, body)
  await store.putFile(key, file)
}

describe('bucket store', () => {
  test('uploads with the type and an immutable cache policy, checked by MD5 and hash', async () => {
    await putLocal()
    await store.upload(KEY, 'image/jpeg')
    const object = s3.objects.get(objectPath(KEY))!
    expect(object.body.equals(BODY)).toBe(true)
    expect(object.contentType).toBe('image/jpeg')
    expect(object.cacheControl).toBe(IMMUTABLE)
    expect(IMMUTABLE).toBe('public, max-age=31536000, immutable')
    const put = s3.requests.find((r) => r.method === 'PUT')!
    expect(put.key).toBe(`${KEY.slice(0, 2)}/${KEY.slice(2, 4)}/${KEY}`)
    expect(put.headers['content-md5']).toBe(
      createHash('md5').update(BODY).digest('base64'),
    )
    expect(put.headers['x-amz-content-sha256']).toBe(KEY)
    // No storage class: the bucket's default (Standard).
    expect(put.headers['x-amz-storage-class']).toBeUndefined()
    // Read back after the upload.
    expect(s3.requests.at(-1)!.method).toBe('HEAD')
    // The local file stays.
    expect(await store.local.stat(KEY)).toBe(BODY.length)
  })

  test('an upload of a corrupt local file is refused', async () => {
    await putLocal(Buffer.from('other bytes'), KEY)
    await expect(store.upload(KEY, 'image/jpeg')).rejects.toThrow(
      'does not match its hash',
    )
    expect(s3.objects.size).toBe(0)
  })

  test('the public URL only for confirmed uploads, and never for downloads', () => {
    expect(store.url(KEY, { contentType: 'video/mp4', remote: true })).toBe(
      `${FAKE_PUBLIC}/${objectPath(KEY)}`,
    )
    expect(store.url(KEY, { contentType: 'video/mp4' })).toMatch(
      new RegExp(String.raw`^/media/${KEY}\?`),
    )
    expect(
      store.url(KEY, {
        contentType: 'video/mp4',
        filename: 'a.mp4',
        remote: true,
      }),
    ).toMatch(new RegExp(String.raw`^/media/${KEY}\?.*n=a.mp4`))
  })

  test('reads the local file first, then the bucket, ranges included', async () => {
    s3.seed(objectPath(KEY), BODY)
    expect(await store.stat(KEY)).toBe(BODY.length)
    expect(await text(await store.read(KEY, { start: 2, end: 6 }))).toBe(
      'media',
    )
    expect(s3.requests.find((r) => r.method === 'GET')!.range).toBe('bytes=2-6')
    await putLocal()
    s3.requests.length = 0
    expect(await text(await store.read(KEY))).toBe(BODY.toString())
    expect(s3.requests).toEqual([])
    await expect(store.read('0'.repeat(64))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('deleting purges the public URL, then removes the object', async () => {
    await putLocal()
    s3.seed(objectPath(KEY), BODY)
    await store.delete(KEY)
    expect(await store.local.stat(KEY)).toBeUndefined()
    expect(s3.objects.size).toBe(0)
    expect(s3.purged).toEqual([`${FAKE_PUBLIC}/${objectPath(KEY)}`])
    // Not in the bucket: nothing to purge.
    await store.delete(KEY)
    expect(s3.purged).toHaveLength(1)
  })

  test('a failed purge keeps the object for the next attempt', async () => {
    s3.seed(objectPath(KEY), BODY)
    s3.failPurge = true
    await expect(store.delete(KEY)).rejects.toThrow('cache purge failed: 500')
    expect(s3.objects.size).toBe(1)
    s3.failPurge = false
    await store.delete(KEY)
    expect(s3.objects.size).toBe(0)
    expect(s3.purged).toHaveLength(1)
  })

  test('without the zone, the purge is logged and skipped', async () => {
    const logs = recordingLogger()
    const unpurged = s3.store(
      { dir: path.join(dir, 'media'), signer, logger: logs.logger },
      { zone: false },
    )
    s3.seed(objectPath(KEY), BODY)
    await unpurged.delete(KEY)
    expect(s3.objects.size).toBe(0)
    expect(s3.purged).toEqual([])
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        msg: 'cache purge skipped: no CF_ZONE_ID configured',
        url: `${FAKE_PUBLIC}/${objectPath(KEY)}`,
      }),
    )
  })

  test('S3 server errors are retried', async () => {
    await putLocal()
    s3.failNext = 2
    await store.upload(KEY, 'image/jpeg')
    expect(s3.objects.size).toBe(1)
  })

  test('the media route streams a download from the bucket', async () => {
    s3.seed(objectPath(KEY), BODY, { contentType: 'video/mp4' })
    const app = mediaRoutes(store, signer, { sharedCache: true })
    const response = await app.request(
      store.url(KEY, {
        contentType: 'video/mp4',
        filename: 'clip.mp4',
        remote: true,
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="clip.mp4"',
    )
    expect(response.headers.get('cache-control')).toMatch(/^private/)
    expect(await response.text()).toBe(BODY.toString())
    expect(s3.requests.map((r) => r.method)).toEqual(['HEAD', 'GET'])
    const ranged = await app.request(
      store.url(KEY, { contentType: 'video/mp4', filename: 'clip.mp4' }),
      { headers: { Range: 'bytes=0-0' } },
    )
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('a')
  })

  test('images, thumbnails included, may be kept by the CDN; video may not', async () => {
    await putLocal()
    const app = mediaRoutes(store, signer, { sharedCache: true })
    const image = await app.request(
      store.url(KEY, { contentType: 'image/webp' }),
    )
    expect(image.headers.get('cache-control')).toBe(IMMUTABLE)
    const video = await app.request(
      store.url(KEY, { contentType: 'video/mp4' }),
    )
    expect(video.headers.get('cache-control')).toMatch(
      /^private, max-age=\d+, immutable$/,
    )
    const local = await mediaRoutes(store, signer).request(
      store.url(KEY, { contentType: 'image/webp' }),
    )
    expect(local.headers.get('cache-control')).toMatch(/^private/)
  })

  test('the local file can go once the bucket has it', async () => {
    await putLocal()
    await store.upload(KEY, 'image/jpeg')
    await store.deleteLocal(KEY)
    expect(await store.local.stat(KEY)).toBeUndefined()
    expect(s3.objects.has(objectPath(KEY))).toBe(true)
    expect(await text(await store.read(KEY))).toBe(BODY.toString())
  })
})
