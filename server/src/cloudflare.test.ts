import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openBucketStore } from '#blob/open.ts'
import { S3Bucket } from '#blob/s3.ts'
import { MediaSigner } from '#blob/signer.ts'
import { objectPath } from '#blob/store.ts'
import {
  r2Credentials,
  resolveR2Credentials,
  verifyToken,
} from '#cloudflare.ts'
import {
  FAKE_ACCOUNT,
  FAKE_BUCKET,
  FAKE_TOKEN,
  FAKE_TOKEN_ID,
  FAKE_ZONE,
  FakeS3,
} from '#testing/fake-s3.ts'
import { recordingLogger } from '#testing/logs.ts'

let s3: FakeS3
beforeEach(async () => {
  s3 = await new FakeS3().start()
})
afterEach(() => s3.stop())

const cloudflare = (apiToken = FAKE_TOKEN) => ({
  accountId: FAKE_ACCOUNT,
  apiToken,
  zoneId: FAKE_ZONE,
})

describe('R2 credentials from the API token', () => {
  test('the key id is the token id from the verify endpoint', async () => {
    expect(await verifyToken(cloudflare(), { apiBase: s3.apiBase })).toBe(
      FAKE_TOKEN_ID,
    )
  })

  test('the secret is the SHA-256 of the token in hex', () => {
    expect(r2Credentials('id', 'token')).toEqual({
      accessKeyId: 'id',
      secretAccessKey:
        '3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0',
    })
    expect(r2Credentials('id', 'token').secretAccessKey).toBe(
      createHash('sha256').update('token').digest('hex'),
    )
  })

  test('a rejected token fails the configuration without naming it', async () => {
    const { logger, entries } = recordingLogger()
    const error = await resolveR2Credentials(
      cloudflare('wrong-secret-token'),
      logger,
      { apiBase: s3.apiBase, retryDelayMs: 1 },
    ).then(
      () => new Error('verified'),
      (error_: unknown) => error_ as Error,
    )
    expect(error.message).toBe(
      'Invalid configuration:\nCF_API_TOKEN could not be verified: token verify failed: 401 1000 Invalid API Token',
    )
    // Not tried again: the token is wrong, not the network.
    expect(s3.verified).toBe(1)
    expect(JSON.stringify(entries)).toContain(
      'cloudflare token verification failed',
    )
    expect(JSON.stringify(entries)).not.toContain('wrong-secret-token')
  })

  test('server errors and network failures are tried again', async () => {
    let calls = 0
    const flaky: typeof fetch = async (input, init) => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      if (calls === 2) return new Response('{}', { status: 502 })
      return fetch(input, init)
    }
    expect(
      await verifyToken(cloudflare(), {
        apiBase: s3.apiBase,
        fetch: flaky,
        retryDelayMs: 1,
      }),
    ).toBe(FAKE_TOKEN_ID)
    expect(calls).toBe(3)
  })

  test('a disabled token is refused', async () => {
    const disabled: typeof fetch = async () =>
      Response.json({
        success: true,
        result: { id: FAKE_TOKEN_ID, status: 'disabled' },
      })
    await expect(
      verifyToken(cloudflare(), { fetch: disabled }),
    ).rejects.toThrow('token is disabled')
  })

  test('the bucket and the purge use what the token gives', async () => {
    const { logger } = recordingLogger()
    const credentials = await resolveR2Credentials(cloudflare(), logger, {
      apiBase: s3.apiBase,
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'midden-cf-'))
    const store = openBucketStore({
      r2: {
        endpoint: s3.endpoint,
        bucket: FAKE_BUCKET,
        publicUrl: 'https://media.test',
      },
      cloudflare: cloudflare(),
      credentials,
      mediaDir: dir,
      signer: new MediaSigner({ secret: new TextEncoder().encode('test') }),
      logger,
      apiBase: s3.apiBase,
    })
    // The fake checks each SigV4 signature against the derived secret.
    const body = Buffer.from('hello')
    const hash = createHash('sha256').update(body).digest('hex')
    const key = objectPath(hash)
    const file = path.join(dir, 'upload')
    writeFileSync(file, body)
    await store.bucket.put(key, file, {
      size: body.length,
      contentType: 'text/plain',
      cacheControl: 'no-cache',
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('base64'),
    })
    expect(s3.objects.get(key)?.body.toString()).toBe('hello')
    expect(await store.bucket.head(key)).toMatchObject({ size: 5 })
    const presigned = await store.bucket.presign(key, 60)
    expect(await (await fetch(presigned)).text()).toBe('hello')
    // The purge sends the same token; the fake accepts no other.
    await store.delete(hash)
    expect(s3.purged).toEqual([`https://media.test/${key}`])
  })

  test('the bucket refuses keys not derived from the token', async () => {
    const bucket = new S3Bucket({
      endpoint: s3.endpoint,
      bucket: FAKE_BUCKET,
      accessKeyId: FAKE_TOKEN_ID,
      secretAccessKey: 'not-the-hash',
      retryDelayMs: 1,
    })
    await expect(bucket.get('missing')).rejects.toThrow(
      'S3 GetObject failed: 403 AccessDenied',
    )
  })
})
