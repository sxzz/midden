// An in-memory S3 bucket and Cloudflare purge API on a local port, for the
// media store tests. It checks what R2 checks of an upload (length, MD5,
// signed payload hash) and records every request.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { BucketBlobStore } from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { cachePurge } from '#blob/purge.ts'
import { parseRange } from '#blob/route.ts'
import { S3Bucket } from '#blob/s3.ts'
import type { MediaSigner } from '#blob/signer.ts'
import type { Logger } from '#log.ts'

export interface FakeObject {
  body: Buffer
  contentType?: string
  cacheControl?: string
  etag: string
  metadata: Record<string, string>
  checksumSha256?: string
}

export interface FakeRequest {
  method: string
  /** The object key, without the bucket. */
  key: string
  range?: string
  presigned: boolean
  headers: Record<string, string>
}

export const FAKE_BUCKET = 'media'
export const FAKE_PUBLIC = 'https://media.test'
export const FAKE_ZONE = 'f'.repeat(32)
export const FAKE_TOKEN = 'purge-token'
const ACCESS_KEY = 'test-access-key'

const md5 = (body: Buffer) => createHash('md5').update(body).digest()
const xml = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>()
  readonly requests: FakeRequest[] = []
  readonly purged: string[] = []
  /** Answer this many coming S3 requests with a 500. */
  failNext = 0
  /** Answer every request for these keys with a 500. */
  readonly failKeys = new Set<string>()
  /** Answer purges with an error. */
  failPurge = false
  /** Held before an upload is stored, while set. */
  gate: Promise<void> | undefined
  /** Stored over what uploads send, while set, as a faulty bucket might. */
  overwrite: Partial<FakeObject> | undefined
  #server: Server
  endpoint = ''

  constructor() {
    this.#server = createServer(async (req, res) => {
      try {
        const { status, headers = {}, body } = await this.#handle(req)
        res.writeHead(status, headers)
        res.end(body)
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.#server.listen(0, '127.0.0.1', resolve),
    )
    const address = this.#server.address() as { port: number }
    this.endpoint = `http://127.0.0.1:${address.port}`
    return this
  }

  stop(): Promise<void> {
    this.#server.closeAllConnections()
    return new Promise((resolve) => this.#server.close(() => resolve()))
  }

  /** Put an object as another tool (rclone, say) would have. */
  seed(key: string, body: Buffer, object: Partial<FakeObject> = {}): void {
    this.objects.set(key, {
      body,
      etag: md5(body).toString('hex'),
      metadata: {},
      ...object,
    })
  }

  /** A media store over `dir` backed by this bucket. */
  store(
    media: { dir: string; signer: MediaSigner; logger: Logger },
    options: { purgeToken?: boolean } = {},
  ): BucketBlobStore {
    return new BucketBlobStore({
      local: new FsBlobStore(media.dir, media.signer),
      bucket: new S3Bucket({
        endpoint: this.endpoint,
        bucket: FAKE_BUCKET,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: 'test-secret',
        retryDelayMs: 1,
      }),
      publicUrl: FAKE_PUBLIC,
      purge: cachePurge({
        ...(options.purgeToken === false
          ? {}
          : { zoneId: FAKE_ZONE, token: FAKE_TOKEN }),
        logger: media.logger,
        apiBase: `${this.endpoint}/client/v4`,
      }),
    })
  }

  async #handle(req: IncomingMessage): Promise<{
    status: number
    headers?: Record<string, string>
    body?: Buffer | string
  }> {
    const url = new URL(req.url!, 'http://fake')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    if (url.pathname === `/client/v4/zones/${FAKE_ZONE}/purge_cache`) {
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return { status: 403, body: '{"success":false}' }
      if (this.failPurge)
        return {
          status: 500,
          body: JSON.stringify({
            success: false,
            errors: [{ code: 1, message: 'nope' }],
          }),
        }
      this.purged.push(...(JSON.parse(body.toString()).files as string[]))
      return { status: 200, body: '{"success":true}' }
    }
    const prefix = `/${FAKE_BUCKET}/`
    if (!url.pathname.startsWith(prefix)) return { status: 400 }
    const key = url.pathname.slice(prefix.length)
    const presigned = url.searchParams.has('X-Amz-Signature')
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [name, String(value)]),
    )
    this.requests.push({
      method: req.method!,
      key,
      presigned,
      headers,
      ...(req.headers.range ? { range: req.headers.range } : {}),
    })
    const signed = presigned
      ? url.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)
      : req.headers.authorization?.startsWith(
          `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/`,
        )
    if (!signed) return { status: 403, body: xml('AccessDenied') }
    if (this.failNext > 0 || this.failKeys.has(key)) {
      if (this.failNext > 0) this.failNext--
      return { status: 500, body: xml('InternalError') }
    }
    switch (req.method) {
      case 'PUT':
        return req.headers['x-amz-copy-source']
          ? this.#copy(key, req)
          : this.#put(key, req, body)
      case 'HEAD':
      case 'GET':
        return this.#get(key, req)
      case 'DELETE':
        this.objects.delete(key)
        return { status: 204 }
      default:
        return { status: 405 }
    }
  }

  async #put(key: string, req: IncomingMessage, body: Buffer) {
    await this.gate
    if (Number(req.headers['content-length']) !== body.length)
      return { status: 400, body: xml('IncompleteBody') }
    const digest = md5(body)
    if (
      req.headers['content-md5'] &&
      req.headers['content-md5'] !== digest.toString('base64')
    )
      return { status: 400, body: xml('BadDigest') }
    const payload = req.headers['x-amz-content-sha256']
    const sha256 = createHash('sha256').update(body).digest()
    if (payload !== 'UNSIGNED-PAYLOAD' && payload !== sha256.toString('hex'))
      return { status: 400, body: xml('XAmzContentSHA256Mismatch') }
    this.objects.set(key, {
      body,
      contentType: req.headers['content-type'],
      cacheControl: req.headers['cache-control'],
      etag: digest.toString('hex'),
      metadata: metadataOf(req),
      ...this.overwrite,
    })
    return { status: 200, headers: { ETag: `"${digest.toString('hex')}"` } }
  }

  #copy(key: string, req: IncomingMessage) {
    const source = this.objects.get(
      String(req.headers['x-amz-copy-source']).replace(`/${FAKE_BUCKET}/`, ''),
    )
    if (!source) return { status: 404, body: xml('NoSuchKey') }
    const replace = req.headers['x-amz-metadata-directive'] === 'REPLACE'
    this.objects.set(key, {
      ...source,
      ...(replace
        ? {
            contentType: req.headers['content-type'],
            cacheControl: req.headers['cache-control'],
            metadata: metadataOf(req),
          }
        : {}),
    })
    return {
      status: 200,
      body: `<CopyObjectResult><ETag>"${source.etag}"</ETag></CopyObjectResult>`,
    }
  }

  #get(key: string, req: IncomingMessage) {
    const object = this.objects.get(key)
    if (!object)
      return {
        status: 404,
        body: req.method === 'HEAD' ? undefined : xml('NoSuchKey'),
      }
    const headers: Record<string, string> = {
      'Content-Length': String(object.body.length),
      ETag: `"${object.etag}"`,
      ...(object.contentType ? { 'Content-Type': object.contentType } : {}),
      ...(object.cacheControl ? { 'Cache-Control': object.cacheControl } : {}),
      ...(object.checksumSha256
        ? { 'x-amz-checksum-sha256': object.checksumSha256 }
        : {}),
    }
    for (const [name, value] of Object.entries(object.metadata))
      headers[`x-amz-meta-${name}`] = value
    if (req.method === 'HEAD') return { status: 200, headers }
    const range = parseRange(req.headers.range, object.body.length)
    if (!range) return { status: 200, headers, body: object.body }
    headers['Content-Length'] = String(range.end - range.start + 1)
    headers['Content-Range'] =
      `bytes ${range.start}-${range.end}/${object.body.length}`
    return {
      status: 206,
      headers,
      body: object.body.subarray(range.start, range.end + 1),
    }
  }
}

function metadataOf(req: IncomingMessage): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers))
    if (name.startsWith('x-amz-meta-'))
      metadata[name.slice('x-amz-meta-'.length)] = String(value)
  return metadata
}
