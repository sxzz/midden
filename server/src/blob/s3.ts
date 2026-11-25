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
  cacheControl: string
  /** Hex SHA-256 of the bytes: signed as the payload hash, so checked. */
  sha256: string
  /** Base64 MD5 of the bytes, checked by the service. */
  md5: string
  signal?: AbortSignal
}

/** A request the service answered with an error. */
export class S3Error extends Error {
  override name = 'S3Error'
  readonly status: number
  readonly code: string
  constructor(operation: string, status: number, code: string) {
    super(`S3 ${operation} failed: ${status}${code ? ` ${code}` : ''}`)
    this.status = status
    this.code = code
  }
}

const ATTEMPTS = 3
const REQUEST_TIMEOUT = 60_000
const META = 'x-amz-meta-'
const TRAILING_SLASHES = /\/+$/
const XML_CODE = /<Code>([^<]{1,100})<\/Code>/

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
    options: { query?: boolean; expires?: number } = {},
  ) {
    const url = this.#url(key)
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
   * Send a request, again on network errors, 5xx and 429. The body is made
   * per attempt, so a file can be streamed each time.
   */
  async #send(
    operation: string,
    method: string,
    key: string,
    headers: Record<string, string>,
    init: {
      body?: () => ReadableStream
      signal?: AbortSignal
      timeout?: number | false
      ok?: (status: number) => boolean
    } = {},
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const signed = await this.#sign(method, key, headers)
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
        await sleep(attempt * this.#retryDelay)
        continue
      }
      if (response.ok || init.ok?.(response.status)) return response
      const code = await errorCode(response)
      lastError = new S3Error(operation, response.status, code)
      if (response.status < 500 && response.status !== 429) throw lastError
      await sleep(attempt * this.#retryDelay)
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

  /** Upload a local file in one request. */
  async put(key: string, file: string, options: PutOptions): Promise<void> {
    const response = await this.#send(
      'PutObject',
      'PUT',
      key,
      {
        'Content-Length': String(options.size),
        'Content-Type': options.contentType,
        'Cache-Control': options.cacheControl,
        'Content-MD5': options.md5,
        'X-Amz-Content-Sha256': options.sha256,
      },
      {
        body: () =>
          Readable.toWeb(createReadStream(file)) as unknown as ReadableStream,
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
  async replaceHeaders(
    key: string,
    headers: {
      contentType: string
      cacheControl: string
      metadata?: Record<string, string>
    },
  ): Promise<void> {
    const meta = Object.fromEntries(
      Object.entries(headers.metadata ?? {}).map(([name, value]) => [
        `${META}${name}`,
        value,
      ]),
    )
    const response = await this.#send('CopyObject', 'PUT', key, {
      ...meta,
      'Content-Type': headers.contentType,
      'Cache-Control': headers.cacheControl,
      'x-amz-copy-source': `/${this.#bucket}/${key}`,
      'x-amz-metadata-directive': 'REPLACE',
    })
    // S3 can report a failed copy in a 200 body.
    const body = await response.text()
    if (body.includes('<Error>'))
      throw new S3Error('CopyObject', response.status, xmlCode(body))
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
