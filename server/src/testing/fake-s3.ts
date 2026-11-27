// An in-memory S3 bucket and Cloudflare's token verify and purge APIs on a
// local port, for the media store tests. It checks what R2 checks of an
// upload (length, MD5, signed payload hash) and records every request. The
// bucket accepts only the S3 key pair derived from FAKE_TOKEN.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { AwsV4Signer } from 'aws4fetch'
import { BucketBlobStore } from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { cachePurge } from '#blob/purge.ts'
import { parseRange } from '#blob/route.ts'
import { S3Bucket } from '#blob/s3.ts'
import { r2Credentials } from '#cloudflare.ts'
import { RawStore, type RawStoreOptions } from '#raw/store.ts'
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
export const FAKE_ACCOUNT = 'a'.repeat(32)
/** The account API token, and the id its verify endpoint gives. */
export const FAKE_TOKEN = 'cloudflare-api-token'
export const FAKE_TOKEN_ID = 'f00dfeed'
const ACCESS_KEY = FAKE_TOKEN_ID

const md5 = (body: Buffer) => createHash('md5').update(body).digest()
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=/
const xml = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>()
  /** Multipart uploads in progress, by id. */
  readonly uploads = new Map<
    string,
    { key: string; parts: Map<number, Buffer> }
  >()
  #nextUpload = 1
  readonly requests: FakeRequest[] = []
  readonly purged: string[] = []
  /** Token verify requests answered. */
  verified = 0
  /** Answer this many coming S3 requests with a 500. */
  failNext = 0
  /** Answer this many coming S3 requests with a 429, as a rate limit. */
  rateLimitNext = 0
  /** Sent as `Retry-After` with those 429s, when set. */
  retryAfter: string | undefined
  /**
   * Answer a write to a key while another write to it is under way with a
   * 429, as R2 limits writes to one key to about one a second.
   */
  oneWritePerKey = false
  /** Requests answered with a 429. */
  limited = 0
  readonly #writing = new Set<string>()
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
  readonly bucket: string

  constructor(options: { bucket?: string } = {}) {
    this.bucket = options.bucket ?? FAKE_BUCKET
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

  /** The Cloudflare API base of this fake. */
  get apiBase(): string {
    return `${this.endpoint}/client/v4`
  }

  /** The raw response store, backed by this bucket. */
  rawStore(options: RawStoreOptions = {}): RawStore {
    return new RawStore(this.s3(), { pauseMs: 10, ...options })
  }

  /** A client of this bucket. */
  s3(): S3Bucket {
    return new S3Bucket({
      endpoint: this.endpoint,
      bucket: this.bucket,
      ...r2Credentials(FAKE_TOKEN_ID, FAKE_TOKEN),
      retryDelayMs: 1,
    })
  }

  /** A media store over `dir` backed by this bucket. */
  store(
    media: { dir: string; signer: MediaSigner; logger: Logger },
    options: { zone?: boolean } = {},
  ): BucketBlobStore {
    return new BucketBlobStore({
      local: new FsBlobStore(media.dir, media.signer),
      bucket: this.s3(),
      publicUrl: FAKE_PUBLIC,
      purge: cachePurge({
        ...(options.zone === false ? {} : { zoneId: FAKE_ZONE }),
        token: FAKE_TOKEN,
        logger: media.logger,
        apiBase: `${this.endpoint}/client/v4`,
      }),
    })
  }

  /**
   * Whether the request carries a valid SigV4 signature made with the key
   * pair derived from FAKE_TOKEN: signed again here and compared.
   */
  async #signedByToken(req: IncomingMessage, url: URL): Promise<boolean> {
    const query = url.searchParams
    const presigned = query.has('X-Amz-Signature')
    const auth = AUTHORIZATION.exec(req.headers.authorization ?? '')
    const credential = presigned ? query.get('X-Amz-Credential') : auth?.[1]
    const signedHeaders = presigned
      ? query.get('X-Amz-SignedHeaders')
      : auth?.[2]
    const datetime = presigned
      ? query.get('X-Amz-Date')
      : String(req.headers['x-amz-date'] ?? '')
    if (
      !credential?.startsWith(`${ACCESS_KEY}/`) ||
      !signedHeaders ||
      !datetime
    )
      return false
    const target = new URL(`${this.endpoint}${req.url}`)
    target.searchParams.delete('X-Amz-Signature')
    const headers: Record<string, string> = {}
    for (const name of signedHeaders.split(';'))
      if (name !== 'host') headers[name] = String(req.headers[name] ?? '')
    const signer = new AwsV4Signer({
      url: target.href,
      method: req.method!,
      headers,
      service: 's3',
      region: credential.split('/', 3)[2],
      datetime,
      signQuery: presigned,
      ...r2Credentials(FAKE_TOKEN_ID, FAKE_TOKEN),
    })
    const expected = await signer.sign()
    return presigned
      ? expected.url.searchParams.get('X-Amz-Signature') ===
          query.get('X-Amz-Signature')
      : expected.headers.get('authorization') === req.headers.authorization
  }

  async #handle(req: IncomingMessage): Promise<{
    status: number
    headers?: Record<string, string>
    body?: Buffer | string
  }> {
    const url = new URL(req.url!, 'http://fake')
    if (url.pathname === `/client/v4/accounts/${FAKE_ACCOUNT}/tokens/verify`) {
      this.verified++
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`)
        return {
          status: 401,
          body: JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: 'Invalid API Token' }],
          }),
        }
      return {
        status: 200,
        body: JSON.stringify({
          success: true,
          errors: [],
          result: { id: FAKE_TOKEN_ID, status: 'active' },
        }),
      }
    }
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
    const prefix = `/${this.bucket}/`
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
    if (!(await this.#signedByToken(req, url)))
      return { status: 403, body: xml('AccessDenied') }
    if (this.failNext > 0 || this.failKeys.has(key)) {
      if (this.failNext > 0) this.failNext--
      return { status: 500, body: xml('InternalError') }
    }
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--
      return this.#limit()
    }
    const uploadId = url.searchParams.get('uploadId')
    if (req.method === 'POST' && url.searchParams.has('uploads'))
      return this.#createMultipart(key)
    if (uploadId) return this.#multipart(req, url, key, uploadId, body)
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

  #limit(): { status: number; headers: Record<string, string>; body: string } {
    this.limited++
    const headers: Record<string, string> = {}
    if (this.retryAfter) headers['Retry-After'] = this.retryAfter
    return { status: 429, headers, body: xml('TooManyRequests') }
  }

  async #put(key: string, req: IncomingMessage, body: Buffer) {
    if (this.oneWritePerKey) {
      if (this.#writing.has(key)) return this.#limit()
      this.#writing.add(key)
    }
    try {
      // Long enough for writes sent together to overlap.
      if (this.oneWritePerKey) await new Promise((r) => setTimeout(r, 20))
      return await this.#store(key, req, body)
    } finally {
      if (this.oneWritePerKey) this.#writing.delete(key)
    }
  }

  async #store(key: string, req: IncomingMessage, body: Buffer) {
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

  #createMultipart(key: string) {
    const id = `upload-${this.#nextUpload++}`
    this.uploads.set(id, { key, parts: new Map() })
    return {
      status: 200,
      body: `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    }
  }

  /** UploadPart, CompleteMultipartUpload and AbortMultipartUpload. */
  #multipart(
    req: IncomingMessage,
    url: URL,
    key: string,
    id: string,
    body: Buffer,
  ) {
    const upload = this.uploads.get(id)
    if (!upload || upload.key !== key)
      return { status: 404, body: xml('NoSuchUpload') }
    if (req.method === 'DELETE') {
      this.uploads.delete(id)
      return { status: 204 }
    }
    if (req.method === 'PUT') {
      const digest = md5(body)
      if (req.headers['content-md5'] !== digest.toString('base64'))
        return { status: 400, body: xml('BadDigest') }
      const sha256 = createHash('sha256').update(body).digest('hex')
      if (req.headers['x-amz-content-sha256'] !== sha256)
        return { status: 400, body: xml('XAmzContentSHA256Mismatch') }
      upload.parts.set(Number(url.searchParams.get('partNumber')), body)
      return { status: 200, headers: { ETag: `"${digest.toString('hex')}"` } }
    }
    // Complete: the parts in order, all but the last at least 5 MiB.
    const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)</g)].map(
      (m) => Number(m[1]),
    )
    const parts = numbers.map((n) => upload.parts.get(n))
    if (
      !parts.length ||
      parts.some(
        (part, i) =>
          !part || (i < parts.length - 1 && part.length < 5 * 2 ** 20),
      )
    )
      return { status: 400, body: xml('InvalidPart') }
    const etag = `${md5(Buffer.concat(parts.map((part) => md5(part!)))).toString('hex')}-${parts.length}`
    this.objects.set(key, {
      body: Buffer.concat(parts as Buffer[]),
      etag,
      metadata: {},
    })
    this.uploads.delete(id)
    return {
      status: 200,
      body: `<CompleteMultipartUploadResult><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`,
    }
  }

  #copy(key: string, req: IncomingMessage) {
    const source = this.objects.get(
      String(req.headers['x-amz-copy-source']).replace(`/${this.bucket}/`, ''),
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
