import { Buffer } from 'node:buffer'
import {
  FetchResponse,
  ResolveResponse,
  Visibility,
  type ObjectRef,
  type SourceResponse,
} from '../protocol.ts'
import { Metadata, status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { attachEntities } from './entities.ts'

export class ProviderError extends Error {
  metadata = new Metadata()
  code: status
  /** The source answered 429 (or X's error 88). */
  rateLimited = false
  constructor(code: status, message: string, retrySeconds = 0) {
    super(message)
    this.code = code
    if (retrySeconds > 0)
      this.metadata.set('retry-after', String(Math.min(86400, retrySeconds)))
  }
}
/** Trailer telling the core to repeat a deferred fetch with the account. */
export const credentialRequiredKey = 'credential-required'
/** Trailer telling the core the post itself is gone, not merely unreadable. */
export const sourceStateKey = 'source-state'
export type SourceState = 'deleted' | 'suspended'
export function sourceState(error: unknown): SourceState | undefined {
  if (!(error instanceof ProviderError)) return
  const [value] = error.metadata.get(sourceStateKey)
  return value === 'deleted' || value === 'suspended' ? value : undefined
}
/**
 * What a failed request was for. An X GraphQL or web endpoint (`api`) never
 * says the thing asked about is gone: its 404 means the request itself was
 * refused (a missing transaction ID or an expired query).
 */
export type ErrorTarget = 'post' | 'profile' | 'list' | 'api'
const forbidden: Record<ErrorTarget, string> = {
  post: '采集账号无权访问该帖子',
  profile: '采集账号无权访问该账号',
  list: '采集账号无权查看该列表',
  api: '采集账号无权访问该接口',
}
const failed: Record<ErrorTarget, string> = {
  post: '无法获取该帖子',
  profile: '无法获取该账号资料',
  list: '无法获取关注列表',
  api: 'X 接口请求失败',
}
/** Seconds from a `retry-after` value (delay or date); 0 when absent. */
export function retrySeconds(retry: string | null): number {
  if (!retry) return 0
  if (/^\d+$/.test(retry)) return Number(retry)
  const seconds = Math.ceil((Date.parse(retry) - Date.now()) / 1000)
  return Number.isFinite(seconds) ? seconds : 0
}
export function responseError(
  code: number,
  retry: string | null,
  target: ErrorTarget,
  reason?: unknown,
): ProviderError {
  if (code === 401)
    return new ProviderError(
      status.UNAUTHENTICATED,
      'X 登录已失效，请重新添加账号授权',
    )
  if (code === 403)
    return new ProviderError(status.PERMISSION_DENIED, forbidden[target])
  if (code === 429 || code >= 500) {
    const seconds = retrySeconds(retry)
    const error = new ProviderError(
      status.UNAVAILABLE,
      code === 429 ? '来源平台限流' : '来源平台暂时不可用，请稍后重试',
      seconds,
    )
    error.rateLimited = code === 429
    return error
  }
  // Not retried within this job, but nothing is blocked: a suspension can be
  // lifted, and a later refresh or profile capture asks upstream again.
  if (code === 404 && reason === 'suspended') {
    const error = new ProviderError(
      status.FAILED_PRECONDITION,
      '账号已被封禁，解封后可重新抓取',
    )
    error.metadata.set(sourceStateKey, 'suspended')
    return error
  }
  if (code === 404)
    return new ProviderError(
      status.FAILED_PRECONDITION,
      target === 'post'
        ? '帖子不存在或已删除'
        : target === 'profile'
          ? '账号不存在或已改名'
          : 'X 接口请求被拒绝',
    )
  return new ProviderError(status.FAILED_PRECONDITION, failed[target])
}
// Only the public post API answers 404 for a post that no longer exists; it
// answers 401 for one that exists but is protected. A 404 from the GraphQL
// endpoints means a stale query, so they never mark a post as gone.
function publicPostError(
  code: number,
  retry: string | null,
  reason: unknown,
): ProviderError {
  const error = responseError(code, retry, 'post', reason)
  if (code === 404 && reason !== 'suspended')
    error.metadata.set(sourceStateKey, 'deleted')
  return error
}
// FxTwitter v2 nests a tombstone's reason under `status`.
const upstreamReason = (data: any) => data?.reason ?? data?.status?.reason
/** Error for a failed HTTP response, keeping the reason from its JSON body. */
export async function upstreamError(
  response: Response,
  target: 'post' | 'profile',
): Promise<ProviderError> {
  let reason: unknown
  try {
    const text = await response.text()
    if (text.length <= 64 << 10) reason = upstreamReason(JSON.parse(text))
  } catch {}
  const retry = response.headers.get('retry-after')
  return target === 'post'
    ? publicPostError(response.status, retry, reason)
    : responseError(response.status, retry, target, reason)
}
export async function readJSON(
  response: Response,
  retain?: (body: Buffer) => void,
): Promise<any> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError(status.UNAVAILABLE, '平台返回了空响应')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2 << 20) throw new Error('size')
      chunks.push(value)
    }
    const body = Buffer.concat(chunks)
    retain?.(body)
    return JSON.parse(body.toString('utf8'))
  } catch {
    await reader.cancel()
    throw new ProviderError(status.UNAVAILABLE, '平台返回的数据无效')
  }
}
export function normalize(
  post: any,
  id: string,
  provider: string,
  visibility: Visibility,
  raw?: any,
): FetchResponse {
  if (post?.type === 'tombstone')
    throw new ProviderError(status.PERMISSION_DENIED, '采集账号无权访问该帖子')
  if (
    post?.type !== 'status' ||
    post.id !== id ||
    typeof post.text !== 'string'
  )
    throw new ProviderError(status.UNAVAILABLE, '平台返回的帖子数据无效')
  const result = FetchResponse.fromPartial({
    externalId: id,
    providerId: provider,
    visibility,
    text: post.text.trim(),
    textKind: 'post_text',

    textSource: provider,
    adapterVersion: '0.4.0',
  })
  const warn = (text: string) => {
    result.incomplete = true
    result.warnings.push(text)
  }
  if (post.media) {
    const seen = new Set<string>()
    let unsupported = false
    let invalid = false
    for (const item of post.media.all ?? [
      ...(post.media.photos ?? []),
      ...(post.media.videos ?? []),
    ]) {
      if (!['photo', 'video', 'gif'].includes(item.type)) {
        unsupported = true
        continue
      }
      const kind = item.type === 'photo' ? 'image' : 'video'
      let url = item.url
      if (kind === 'video') {
        const formats = (item.formats ?? [])
          .filter((f: any) => ['mp4', 'webm'].includes(f.container) && f.url)
          .toSorted(
            (a: any, b: any) =>
              (b.width ?? 0) * (b.height ?? 0) -
                (a.width ?? 0) * (a.height ?? 0) ||
              (b.bitrate ?? 0) - (a.bitrate ?? 0),
          )
        if (formats.length) url = formats[0].url
      }
      let parsed: URL
      try {
        parsed = new URL(url)
        if (
          !['https:', 'http:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new Error()
        if (kind === 'video' && !/\.(?:mp4|webm)$/i.test(parsed.pathname))
          throw new Error()
      } catch {
        invalid = true
        continue
      }
      if (seen.has(url)) continue
      seen.add(url)
      result.resources.push({
        url,
        kind,
        purpose: '',
        immutableKey: item.id
          ? `x:media:${kind}:${item.id}`
          : `x:media:${kind}:url:${parsed.href}`,
        altText: (item.altText ?? '').trim(),
        sensitive: Boolean(
          post.possibly_sensitive || item.sensitive || item.possibly_sensitive,
        ),
      })
    }
    if (unsupported || post.media.external) warn('不支持此类媒体。')
    if (invalid) warn('部分媒体缺少有效下载地址。')
  } else {
    warn('未能确认帖子媒体信息。')
  }
  if (post.article) warn('不支持文章正文。')
  if (!result.text && !result.resources.length)
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      '帖子没有可保存的正文或媒体',
    )
  const markers = result.resources
    .map((r) => (r.kind === 'image' ? '[图片]' : '[视频]'))
    .join('')
  attachEntities(result, post, raw)
  // Only what the post has: no stand-in author.
  result.summary = [result.authorName, `${result.text}${markers}`]
    .filter(Boolean)
    .join('：')
  return result
}
export async function fetchPublic(
  id: string,
  signal: AbortSignal,
  endpoint = 'https://api.fxtwitter.com/2/status',
): Promise<FetchResponse> {
  const response = await upstream(fetch, `${endpoint}/${id}`, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Monitor/0.4' },
  })
  if (!response.ok) throw await upstreamError(response, 'post')
  let rawBody = Buffer.alloc(0)
  const data = await readJSON(response, (body) => {
    rawBody = Buffer.from(body)
  })
  if (typeof data.code !== 'number')
    throw new ProviderError(status.UNAVAILABLE, '平台返回的数据无效')
  if (data.code !== 200)
    throw publicPostError(
      data.code,
      response.headers.get('retry-after'),
      upstreamReason(data),
    )
  return publicPost(data.status, id, {
    body: rawBody,
    contentType: response.headers.get('content-type') ?? 'application/json',
    sourceUrl: `${endpoint}/${id}`,
    visibility: Visibility.VISIBILITY_PUBLIC,
  })
}

/** Normalizes a public API status, whichever public response carried it. */
export function publicPost(
  post: any,
  id: string,
  source: SourceResponse,
): FetchResponse {
  // A quoted or reposted post is kept by reference, so only the post's own
  // author decides whether the public provider may save it.
  if (post?.author?.protected)
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      '公共来源无法保存受保护的帖子',
    )
  // A repost's link answers with the reposted post, which is what is saved.
  const original =
    post?.id !== id && post?.reposted_by && /^\d+$/.test(String(post?.id))
      ? String(post.id)
      : id
  const result = normalize(
    original === id ? post : { ...post, reposted_by: null },
    original,
    'fxtwitter',
    Visibility.VISIBILITY_PUBLIC,
  )
  result.sourceResponses = [source]
  if (post?.author?.protected === false && /^\d+$/.test(post.author.id))
    result.publicSubjects.push(profileRef(post.author.id))
  return original === id ? result : asRepost(result, id)
}

/** The profile an X account's posts are kept under. */
export const profileRef = (externalId: string): ObjectRef => ({
  platform: 'x',
  kind: 'profile',
  objectScope: '',
  externalId,
})

/** Saves a repost's link as the reposted post the result describes. */
export function asRepost(result: FetchResponse, id: string): FetchResponse {
  const original = result.externalId
  result.externalId = id
  result.canonicalTarget = ResolveResponse.fromPartial({
    url: `https://x.com/i/web/status/${original}`,
    platform: 'x',
    kind: 'post',
    objectScope: '',
    externalId: original,
  })
  return result
}
