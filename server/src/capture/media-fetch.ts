import { Readable } from 'node:stream'
import { PermanentError, RetryError } from '#jobs/queue.ts'
import type { Incoming } from '#blob/store.ts'
import type { CaptureContext } from './context.ts'

// What a download of an original (`download.ts`) and of a thumbnail
// (`thumbnail.ts`) share: one request to the platform's media server, its
// body streamed into the media store (`BlobStore.receive`): straight into
// the bucket with R2, through a staging file into the directory without.

const SECONDS = /^\d+$/

function retryAfterMs(header: string | null): number {
  if (!header) return 0
  if (SECONDS.test(header)) return Number(header) * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(at - Date.now(), 0)
}

/** The address of a media file, if it is one we fetch. */
export function mediaURL(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PermanentError('媒体地址无效')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new PermanentError('媒体地址无效')
  return url
}

/**
 * Fetch a media file into the media store, not yet kept under its hash.
 * Errors say whether trying again could help: a server that is busy or down
 * may come back (and says when, with `Retry-After`); one that refuses the
 * request will not.
 */
export async function fetchMedia(
  ctx: CaptureContext,
  url: URL,
  signal: AbortSignal,
): Promise<Incoming> {
  let response: Response
  try {
    response = await (ctx.fetch ?? fetch)(url, { signal })
  } catch (error) {
    throw new Error(`媒体请求失败：${(error as Error).message}`, {
      cause: error,
    })
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel()
    const after = retryAfterMs(response.headers.get('retry-after'))
    if (after > 0) throw new RetryError('媒体服务器暂时不可用', after)
    throw new Error('媒体服务器暂时不可用')
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel()
    throw new PermanentError('媒体服务器拒绝了请求')
  }
  try {
    return await ctx.blobs.receive(Readable.fromWeb(response.body), { signal })
  } catch (error) {
    throw new Error('媒体下载被中断', { cause: error })
  }
}
