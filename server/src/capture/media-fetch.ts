import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { stage, type StagedFile } from '#blob/staging.ts'
import { PermanentError, RetryError } from '#jobs/queue.ts'
import type { CaptureContext } from './context.ts'

// What a download of an original (`download.ts`) and of a thumbnail
// (`thumbnail.ts`) share: one request to the platform's media server, its
// body staged in a local file.

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
 * Fetch a media file into the staging directory. Errors say whether trying
 * again could help: a server that is busy or down may come back (and says
 * when, with `Retry-After`); one that refuses the request will not.
 */
export async function fetchMedia(
  ctx: CaptureContext,
  url: URL,
  signal: AbortSignal,
): Promise<StagedFile> {
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
    return await stage(ctx.stagingDir, Readable.fromWeb(response.body), {
      signal,
    })
  } catch (error) {
    throw new Error('媒体下载被中断', { cause: error })
  }
}

/** The first `bytes` of a staged file. */
export async function readHead(file: string, bytes = 512): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(head, 0, bytes, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
