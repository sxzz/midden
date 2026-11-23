import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FsBlobStore } from './fs-store.ts'
import { mediaRoutes, parseRange } from './route.ts'
import { MediaSigner } from './signer.ts'
import { stage, TooLargeError } from './staging.ts'

const secret = new TextEncoder().encode('test secret')
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'midden-blob-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function stored(content: string, signer = new MediaSigner({ secret })) {
  const store = new FsBlobStore(path.join(dir, 'media'), signer)
  const staged = await stage(path.join(dir, 'tmp'), Readable.from([content]))
  await store.putFile(staged.hash, staged.path)
  return { store, key: staged.hash, signer }
}

describe('stage', () => {
  test('hashes and measures the stream', async () => {
    const staged = await stage(dir, Readable.from(['hello ', 'world']))
    expect(staged.hash).toBe(sha256('hello world'))
    expect(staged.size).toBe(11)
  })

  test('rejects oversized streams and leaves nothing behind', async () => {
    await expect(
      stage(path.join(dir, 'tmp'), Readable.from(['0123456789']), {
        maxBytes: 4,
      }),
    ).rejects.toBeInstanceOf(TooLargeError)
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([])
  })
})

describe('FsBlobStore', () => {
  test('stores, reads ranges and deletes', async () => {
    const { store, key } = await stored('abcdefghij')
    expect(await store.stat(key)).toBe(10)
    expect(await text(await store.read(key))).toBe('abcdefghij')
    expect(await text(await store.read(key, { start: 2, end: 4 }))).toBe('cde')
    await store.delete(key)
    expect(await store.stat(key)).toBeUndefined()
    await expect(store.read(key)).rejects.toThrow()
  })

  test('a second copy of the same content is discarded', async () => {
    const { store, key } = await stored('same')
    const again = await stage(path.join(dir, 'tmp'), Readable.from(['same']))
    await store.putFile(key, again.path)
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([])
    expect(await store.stat(key)).toBe(4)
  })

  test('rejects keys that are not content hashes', async () => {
    const { store } = await stored('x')
    await expect(store.stat('../etc/passwd')).rejects.toThrow('Invalid')
  })
})

describe('MediaSigner', () => {
  const key = sha256('k')

  test('verifies its own URLs and rejects tampering', () => {
    const signer = new MediaSigner({ secret })
    const url = new URL(
      signer.sign({ key, contentType: 'image/jpeg' }),
      'http://x',
    )
    expect(signer.verify(key, url.searchParams)).toMatchObject({
      key,
      contentType: 'image/jpeg',
    })
    expect(signer.verify(sha256('other'), url.searchParams)).toBeUndefined()
    url.searchParams.set('t', 'text/html')
    expect(signer.verify(key, url.searchParams)).toBeUndefined()
  })

  test('URLs are stable within a window and expire', () => {
    let now = 0
    const signer = new MediaSigner({ secret, windowMs: 1000, now: () => now })
    const first = signer.sign({ key, contentType: 'image/png' })
    now = 999
    expect(signer.sign({ key, contentType: 'image/png' })).toBe(first)
    const query = new URL(first, 'http://x').searchParams
    now = 1999
    expect(signer.verify(key, query)).toBeDefined()
    now = 2000
    expect(signer.verify(key, query)).toBeUndefined()
  })
})

describe('parseRange', () => {
  test.each([
    ['bytes=0-4', { start: 0, end: 4 }],
    ['bytes=5-', { start: 5, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=8-100', { start: 8, end: 9 }],
    ['bytes=10-', null],
    ['bytes=5-2', null],
    ['bytes=0-1,4-5', undefined],
    [undefined, undefined],
  ])('%s', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected)
  })
})

describe('mediaRoutes', () => {
  test('serves whole objects, ranges and conditional requests', async () => {
    const { store, key, signer } = await stored('0123456789')
    const app = mediaRoutes(store, signer)
    const url = store.url(key, { contentType: 'video/mp4' })

    const whole = await app.request(url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(await whole.text()).toBe('0123456789')

    const part = await app.request(url, { headers: { Range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')

    const beyond = await app.request(url, { headers: { Range: 'bytes=20-' } })
    expect(beyond.status).toBe(416)

    const cached = await app.request(url, {
      headers: { 'If-None-Match': `"${key}"` },
    })
    expect(cached.status).toBe(304)
  })

  test('offers downloads under their name', async () => {
    const { store, key, signer } = await stored('x')
    const response = await mediaRoutes(store, signer).request(
      store.url(key, { contentType: 'image/jpeg', filename: '照片 1.jpg' }),
    )
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="___1.jpg"; filename*=UTF-8''%E7%85%A7%E7%89%87%201.jpg`,
    )
  })

  test('refuses unsigned or missing objects', async () => {
    const { store, key, signer } = await stored('x')
    const app = mediaRoutes(store, signer)
    expect((await app.request(`/media/${key}`)).status).toBe(403)
    const missing = sha256('missing')
    expect(
      (await app.request(store.url(missing, { contentType: 'image/png' })))
        .status,
    ).toBe(404)
  })
})
