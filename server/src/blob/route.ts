import { Readable } from 'node:stream'
import { Hono } from 'hono'
import {
  IMMUTABLE,
  isBlobKey,
  type BlobStore,
  type ByteRange,
} from './store.ts'
import type { MediaSigner } from './signer.ts'

const RANGE = /^bytes=(\d*)-(\d*)$/
const ANY_ORIGIN = '*'

/**
 * Parse a single-range `Range` header. Returns undefined to serve the whole
 * object (absent, malformed or multi-range) and null when unsatisfiable.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | undefined | null {
  const match = header ? RANGE.exec(header.trim()) : null
  if (!match) return undefined
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return undefined
  if (first === '') {
    // Suffix range: the final N bytes.
    const length = Number(last)
    if (length === 0) return null
    return { start: Math.max(size - length, 0), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || start > end) return null
  return { start, end }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replaceAll(/[^\w.-]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export interface MediaRouteOptions {
  /**
   * Let shared caches (the CDN in front) keep images and thumbnails for
   * good. Off, every response is private to the browser and expires with
   * its URL.
   */
  sharedCache?: boolean
  /**
   * Make a missing object again, if it is one that can be (a thumbnail):
   * the key it is now stored under, which may differ.
   */
  regenerate?: (
    key: string,
  ) => Promise<{ key: string; contentType: string } | undefined>
}

/** Serves `/media/:key` for stores whose URLs point back at this process. */
export function mediaRoutes(
  store: BlobStore,
  signer: MediaSigner,
  options: MediaRouteOptions = {},
): Hono {
  const app = new Hono()
  app.get('/media/:key', async (c) => {
    // The web app is on another origin and draws avatars into WebGL (the
    // relation graph), which needs CORS, on redirects too. The signed URL is
    // the only key, so any origin may read what it names, as from R2's.
    c.header('Access-Control-Allow-Origin', ANY_ORIGIN)
    const key = c.req.param('key')
    const media = isBlobKey(key)
      ? signer.verify(key, new URL(c.req.url).searchParams)
      : undefined
    if (!media) return c.body(null, 403)
    let size = await store.stat(key)
    if (size === undefined && options.regenerate) {
      const made = await options.regenerate(key)
      if (made && made.key !== key)
        return c.redirect(
          signer.sign({ key: made.key, contentType: made.contentType }),
          307,
        )
      if (made) size = await store.stat(key)
    }
    if (size === undefined) return c.body(null, 404)

    // Video stays out of the CDN in front of this process: its terms allow
    // that only for video hosted on R2 and the like. Downloads stay private.
    const shared =
      options.sharedCache &&
      !media.filename &&
      !media.contentType.startsWith('video/')
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': media.contentType,
      // The key is the content hash: the bytes never change.
      ETag: `"${key}"`,
      'Cache-Control': shared
        ? IMMUTABLE
        : `private, max-age=${Math.max(Math.floor((media.expiresAt - Date.now()) / 1000), 0)}, immutable`,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': ANY_ORIGIN,
    })
    if (media.filename)
      headers.set('Content-Disposition', contentDisposition(media.filename))
    if (c.req.header('If-None-Match') === `"${key}"`)
      return new Response(null, { status: 304, headers })

    const range = parseRange(c.req.header('Range'), size)
    if (range === null) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    let status = 200
    if (range) {
      status = 206
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      headers.set('Content-Length', String(range.end - range.start + 1))
    } else {
      headers.set('Content-Length', String(size))
    }
    if (c.req.method === 'HEAD') return new Response(null, { status, headers })
    const stream = await store.read(key, range)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status,
      headers,
    })
  })
  return app
}
