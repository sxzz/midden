import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { AwsV4Signer } from 'aws4fetch'
import { notFound, type ByteRange } from './store.ts'

export interface S3Options {
  /** Service root, such as `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  fetch?: typeof fetch
  /** Base delay between attempts. */
  retryDelayMs?: number
}

export interface ObjectHead {
  size: number
  contentType?: string
  cacheControl?: string
  /** Without quotes. A plain MD5 in hex for an object stored in one part. */
  etag?: string
  /** Base64 SHA-256, when the object was stored with that checksum. */
  checksumSha256?: string
  /** User metadata (`x-amz-meta-*`), names lowercased without the prefix. */
  metadata: Record<string, string>
}

export interface PutOptions {
  size: number
  contentType: string
  cacheControl?: string
  /** Hex SHA-256 of the bytes: signed as the payload hash, so checked. */
  sha256: string
  /** Base64 MD5 of the bytes, checked by the service. */
  md5: string
  /** User metadata (`x-amz-meta-*`), by lowercase name without the prefix. */
  metadata?: Record<string, string>
  signal?: AbortSignal
}

/** A request the service answered with an error. */
export class S3Error extends Error {
  override name = 'S3Error'
  readonly status: number
  readonly code: string
  /** How long the service asked to wait (`Retry-After`), if it did. */
  readonly retryAfterMs: number | undefined
  constructor(
    operation: string,
    status: number,
    code: string,
    retryAfterMs?: number,
  ) {
    super(`S3 ${operation} failed: ${status}${code ? ` ${code}` : ''}`)
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  /**
   * Too many requests: R2 answers 429 to writes of one key faster than
   * about one a second, S3 503 SlowDown. Waiting is the remedy.
   */
  get rateLimited(): boolean {
    return this.status === 429 || this.status === 503
  }
}

export function isRateLimited(error: unknown): error is S3Error {
  return error instanceof S3Error && error.rateLimited
}

/** Tries of one request before its error reaches the caller. */
export const S3_ATTEMPTS = 5
// A longer Retry-After is not waited out inside one request: the error
// carries it, and the caller pauses for it.
const LONGEST_WAIT = 30_000
const SECONDS = /^\d+$/

/** `Retry-After` in ms: seconds or an HTTP date; undefined if absent. */
export function retryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined
  if (SECONDS.test(header.trim())) return Number(header) * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(at - now, 0)
}

/**
 * The wait before attempt `attempt + 1`: what the service asked for, else
 * exponential from `base` with jitter (0.5 to 1.5 times), so that requests
 * failing together do not come back together.
 */
export function backoffMs(
  attempt: number,
  base: number,
  retryAfter?: number,
  random = Math.random,
): number {
  if (retryAfter !== undefined) return retryAfter
  return Math.round(base * 2 ** (attempt - 1) * (0.5 + random()))
}

const REQUEST_TIMEOUT = 60_000
const META = 'x-amz-meta-'
const TRAILING_SLASHES = /\/+$/
const XML_CODE = /<Code>([^<]{1,100})<\/Code>/
const UPLOAD_ID = /<UploadId>([^<]+)<\/UploadId>/

/**
 * The few S3 calls the media store makes, signed with SigV4 and sent with
 * fetch, path-style. Generic S3: nothing here is specific to R2. Errors
 * name the operation, status and S3 code only, never credentials.
 */
export class S3Bucket {
  readonly #endpoint: string
  readonly #bucket: string
  readonly #credentials: {
    accessKeyId: string
    secretAccessKey: string
    region: string
  }
  readonly #fetch: typeof fetch
  readonly #retryDelay: number

  constructor(options: S3Options) {
    this.#endpoint = options.endpoint.replace(TRAILING_SLASHES, '')
    this.#bucket = options.bucket
    this.#credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? 'auto',
    }
    this.#fetch = options.fetch ?? fetch
    this.#retryDelay = options.retryDelayMs ?? 500
  }

  #url(key: string): URL {
    return new URL(`${this.#endpoint}/${this.#bucket}/${key}`)
  }

  #sign(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    options: {
      query?: boolean
      expires?: number
      params?: Record<string, string>
    } = {},
  ) {
    const url = this.#url(key)
    for (const [name, value] of Object.entries(options.params ?? {}))
      url.searchParams.set(name, value)
    if (options.expires)
      url.searchParams.set('X-Amz-Expires', String(options.expires))
    const signer = new AwsV4Signer({
      url: url.href,
      method,
      headers,
      service: 's3',
      signQuery: options.query,
      ...this.#credentials,
    })
    return signer.sign()
  }

  /**
   * Send a request, again on network errors, 5xx and 429, after the wait
   * the service asked for (`Retry-After`) or an exponential one with
   * jitter. The body is made per attempt, so a file can be streamed each
   * time.
   */
  async #send(
    operation: string,
    method: string,
    key: string,
    headers: Record<string, string>,
    init: {
      body?: () => ReadableStream | Uint8Array
      signal?: AbortSignal
      timeout?: number | false
      ok?: (status: number) => boolean
      /** Query parameters, such as a multipart upload's. */
      params?: Record<string, string>
    } = {},
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 1; attempt <= S3_ATTEMPTS; attempt++) {
      const signed = await this.#sign(method, key, headers, {
        params: init.params,
      })
      const signals = [init.signal].filter((s) => s !== undefined)
      if (init.timeout !== false)
        signals.push(AbortSignal.timeout(init.timeout ?? REQUEST_TIMEOUT))
      let response: Response
      try {
        response = await this.#fetch(signed.url, {
          method,
          headers: signed.headers,
          ...(init.body ? { body: init.body(), duplex: 'half' } : {}),
          signal: AbortSignal.any(signals),
        } as RequestInit)
      } catch (error) {
        if (init.signal?.aborted) throw error
        lastError = new Error(`S3 ${operation} failed: ${String(error)}`, {
          cause: error,
        })
        if (attempt < S3_ATTEMPTS)
          await sleep(backoffMs(attempt, this.#retryDelay))
        continue
      }
      if (response.ok || init.ok?.(response.status)) return response
      const code = await errorCode(response)
      const after = retryAfterMs(response.headers.get('retry-after'))
      const failure = new S3Error(operation, response.status, code, after)
      lastError = failure
      if (response.status < 500 && response.status !== 429) throw failure
      if (attempt === S3_ATTEMPTS || (after ?? 0) > LONGEST_WAIT) throw failure
      await sleep(backoffMs(attempt, this.#retryDelay, after))
    }
    throw lastError
  }

  /** The object's size and headers, or undefined when it does not exist. */
  async head(key: string): Promise<ObjectHead | undefined> {
    const response = await this.#send(
      'HeadObject',
      'HEAD',
      key,
      {},
      {
        ok: (status) => status === 404,
      },
    )
    if (response.status === 404) return undefined
    const headers = response.headers
    const metadata: Record<string, string> = {}
    for (const [name, value] of headers)
      if (name.startsWith(META)) metadata[name.slice(META.length)] = value
    const optional = (name: string) => headers.get(name) ?? undefined
    return {
      size: Number(headers.get('content-length') ?? NaN),
      contentType: optional('content-type'),
      cacheControl: optional('cache-control'),
      etag: optional('etag')?.replaceAll('"', ''),
      checksumSha256: optional('x-amz-checksum-sha256'),
      metadata,
    }
  }

  /** Upload a local file, or bytes in memory, in one request. */
  async put(
    key: string,
    source: string | Uint8Array,
    options: PutOptions,
  ): Promise<void> {
    const response = await this.#send(
      'PutObject',
      'PUT',
      key,
      {
        ...metaHeaders(options.metadata),
        'Content-Length': String(options.size),
        'Content-Type': options.contentType,
        ...(options.cacheControl
          ? { 'Cache-Control': options.cacheControl }
          : {}),
        'Content-MD5': options.md5,
        'X-Amz-Content-Sha256': options.sha256,
      },
      {
        body: () =>
          typeof source === 'string'
            ? (Readable.toWeb(
                createReadStream(source),
              ) as unknown as ReadableStream)
            : source,
        signal: options.signal,
        // Large files take as long as the uplink needs.
        timeout: false,
      },
    )
    await response.body?.cancel()
  }

  /** Stream the object, or a range of it; a missing one rejects ENOENT. */
  async get(
    key: string,
    range?: ByteRange,
    signal?: AbortSignal,
  ): Promise<Readable> {
    const response = await this.#send(
      'GetObject',
      'GET',
      key,
      range ? { Range: `bytes=${range.start}-${range.end}` } : {},
      { signal, timeout: false, ok: (status) => status === 404 },
    )
    if (response.status === 404 || !response.body) {
      await response.body?.cancel()
      throw notFound(key)
    }
    return Readable.fromWeb(response.body as never)
  }

  /** Deleting a missing object succeeds, as in S3. */
  async delete(key: string): Promise<void> {
    const response = await this.#send(
      'DeleteObject',
      'DELETE',
      key,
      {},
      {
        ok: (status) => status === 404,
      },
    )
    await response.body?.cancel()
  }

  /**
   * Replace the object's headers by copying it onto itself on the server:
   * no bytes travel. Other user metadata is kept as given.
   */
  replaceHeaders(
    key: string,
    headers: {
      contentType: string
      cacheControl: string
      metadata?: Record<string, string>
    },
  ): Promise<void> {
    return this.copy(key, key, headers)
  }

  /**
   * Copy an object to another key on the server, with new headers: no
   * bytes travel through this process.
   */
  async copy(
    from: string,
    to: string,
    headers: {
      contentType: string
      cacheControl: string
      metadata?: Record<string, string>
    },
  ): Promise<void> {
    const response = await this.#send('CopyObject', 'PUT', to, {
      ...metaHeaders(headers.metadata),
      'Content-Type': headers.contentType,
      'Cache-Control': headers.cacheControl,
      'x-amz-copy-source': `/${this.#bucket}/${from}`,
      'x-amz-metadata-directive': 'REPLACE',
    })
    // S3 can report a failed copy in a 200 body.
    const body = await response.text()
    if (body.includes('<Error>'))
      throw new S3Error('CopyObject', response.status, xmlCode(body))
  }

  /** Start a multipart upload; its id. */
  async createMultipart(key: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#send(
      'CreateMultipartUpload',
      'POST',
      key,
      {},
      { params: { uploads: '' }, signal },
    )
    const id = UPLOAD_ID.exec(await response.text())?.[1]
    if (!id) throw new S3Error('CreateMultipartUpload', response.status, '')
    return id
  }

  /**
   * Upload one part from memory, checked by the service against its MD5
   * and SHA-256 as a whole object is; its ETag.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    part: number,
    bytes: Uint8Array,
    checks: { md5: string; sha256: string; signal?: AbortSignal },
  ): Promise<string> {
    const response = await this.#send(
      'UploadPart',
      'PUT',
      key,
      {
        'Content-Length': String(bytes.length),
        'Content-MD5': checks.md5,
        'X-Amz-Content-Sha256': checks.sha256,
      },
      {
        params: { partNumber: String(part), uploadId },
        body: () => bytes,
        signal: checks.signal,
        timeout: false,
      },
    )
    await response.body?.cancel()
    const etag = response.headers.get('etag')?.replaceAll('"', '')
    if (!etag) throw new S3Error('UploadPart', response.status, '')
    return etag
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { part: number; etag: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.part}</PartNumber><ETag>"${p.etag}"</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
    )
    const response = await this.#send(
      'CompleteMultipartUpload',
      'POST',
      key,
      { 'Content-Type': 'application/xml' },
      { params: { uploadId }, body: () => body, signal },
    )
    const text = await response.text()
    if (text.includes('<Error>'))
      throw new S3Error(
        'CompleteMultipartUpload',
        response.status,
        xmlCode(text),
      )
  }

  /** Abandoning an upload that is gone already succeeds. */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const response = await this.#send(
      'AbortMultipartUpload',
      'DELETE',
      key,
      {},
      { params: { uploadId }, ok: (status) => status === 404 },
    )
    await response.body?.cancel()
  }

  /** A GET URL that works without credentials until it expires. */
  async presign(key: string, expiresSeconds: number): Promise<string> {
    const signed = await this.#sign(
      'GET',
      key,
      {},
      {
        query: true,
        expires: expiresSeconds,
      },
    )
    return signed.url.href
  }
}

function metaHeaders(
  metadata: Record<string, string> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([name, value]) => [`${META}${name}`, value]),
  )
}

function xmlCode(body: string): string {
  return XML_CODE.exec(body)?.[1] ?? ''
}

async function errorCode(response: Response): Promise<string> {
  try {
    return xmlCode(await response.text())
  } catch {
    return ''
  }
}

/** Base64 of a hex digest, as checksum headers carry it. */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}
