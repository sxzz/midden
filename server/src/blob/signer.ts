import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SignedMedia {
  key: string
  contentType: string
  filename?: string
  /** Unix milliseconds. */
  expiresAt: number
}

export interface SignerOptions {
  secret: Uint8Array
  /**
   * URLs are stable within a window and stay valid for one to two windows,
   * so a page reloaded within the window hits the browser cache.
   */
  windowMs?: number
  now?: () => number
}

const DEFAULT_WINDOW = 12 * 60 * 60_000

export class MediaSigner {
  readonly #secret: Uint8Array
  readonly #windowMs: number
  readonly #now: () => number

  constructor(options: SignerOptions) {
    this.#secret = options.secret
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW
    this.#now = options.now ?? Date.now
  }

  /** Path and query of a signed URL, relative to the server root. */
  sign(media: Omit<SignedMedia, 'expiresAt'>): string {
    const expiresAt =
      (Math.floor(this.#now() / this.#windowMs) + 2) * this.#windowMs
    const params = new URLSearchParams({
      e: String(expiresAt),
      t: media.contentType,
    })
    if (media.filename) params.set('n', media.filename)
    params.set('s', this.#mac({ ...media, expiresAt }))
    return `/media/${media.key}?${params}`
  }

  /** The signed request, or undefined when tampered with or expired. */
  verify(key: string, query: URLSearchParams): SignedMedia | undefined {
    const expiresAt = Number(query.get('e'))
    const contentType = query.get('t')
    const signature = query.get('s')
    if (!Number.isSafeInteger(expiresAt) || !contentType || !signature)
      return undefined
    const media: SignedMedia = {
      key,
      contentType,
      filename: query.get('n') ?? undefined,
      expiresAt,
    }
    const expected = Buffer.from(this.#mac(media))
    const actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return undefined
    if (expiresAt <= this.#now()) return undefined
    return media
  }

  #mac(media: SignedMedia): string {
    // Length-prefixed fields: no value can shift into a neighbor.
    const fields = [
      media.key,
      String(media.expiresAt),
      media.contentType,
      media.filename ?? '',
    ]
    const hmac = createHmac('sha256', this.#secret)
    for (const field of fields) hmac.update(`${field.length}:${field}`)
    return hmac.digest('base64url')
  }
}
