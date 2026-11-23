import {
  hc,
  type ClientResponse,
  type InferRequestType,
  type InferResponseType,
  type parseResponse,
} from 'hono/client'
import { host } from './host'
import type { Api } from '@midden/server/api'

/** The server's `/v1` API, typed from its route definitions. */
export const client = hc<Api>('/v1', {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    // Ahead of images and video, which share the same connection.
    fetch(input, { priority: 'high', ...init, credentials: 'same-origin' }),
})

export class APIError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The successful body of a request, or an APIError carrying the status and
 * the server's message.
 */
export async function call<T extends ClientResponse<unknown>>(
  request: T | Promise<T>,
): Promise<Awaited<ReturnType<typeof parseResponse<T>>>> {
  const response = await request
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    throw new APIError(response.status, body.error || '服务暂时不可用')
  }
  return (response.status === 204 ? undefined : await response.json()) as never
}

type Ok<T> = InferResponseType<T, 200>

export type Collection = Ok<(typeof client.collections)[':id']['$get']>
export type CollectionPage = Ok<typeof client.collections.$get>
export type Asset = Collection['assets'][number]
export type Entity = NonNullable<Collection['graph']>['entities'][number]
export type Author = Ok<typeof client.collections.authors.$get>['items'][number]
export type Revision = Ok<
  (typeof client.collections)[':id']['revisions']['$get']
>['items'][number]
export type Job = Ok<(typeof client.jobs)[':id']['$get']>
export type MemberProgress = NonNullable<Job['members']>
export type LibrarySize = Ok<typeof client.library.$get>
export type CaptureRecord = Ok<typeof client.captures.$get>['items'][number]
export type CaptureRecordDetail = Ok<(typeof client.captures)[':id']['$get']>
export type CaptureMedia = CaptureRecordDetail['media_items'][number]
export type CaptureMember = Ok<
  (typeof client.captures)[':id']['members']['$get']
>['items'][number]
export type Usage = Ok<typeof client.usage.$get>
export type Accounts = Ok<typeof client.accounts.$get>
export type Account = Accounts['accounts'][number]
export type AccountPlatform = Accounts['platforms'][number]
export type Tag = Ok<typeof client.tags.$get>[number]
export type Annotation = Ok<
  (typeof client.collections)[':id']['annotation']['$get']
>
export type CaptureOptions = NonNullable<
  Extract<
    InferRequestType<typeof client.captures.$post>['json'],
    { url: string }
  >['options']
>

export function errorText(e: unknown) {
  if (e instanceof APIError) {
    if (e.status === 400 && e.message === 'invalid collection filters')
      return '筛选条件无效。'
    if (e.status === 400 && e.message === 'invalid note or tags')
      return '备注最多 10000 字，标签名最多 64 字，标签最多 100 个。'
    if (e.status === 409 && e.message === 'no more pages')
      return '没有更多帖子了。'
    if (e.status === 400 && e.message === 'unsupported URL')
      return '不支持的链接。'
    if (e.status === 400 && e.message === 'invalid credentials')
      return '凭据无效或已过期。'
    if (
      e.status === 422 &&
      e.message === 'account required; add and select your own credentials'
    )
      return '此平台需要账号，请先在采集账号中添加并选择一个账号。'
    if (e.status === 422 && e.message.startsWith('account unavailable'))
      return '账号不可用，请在采集账号中选择可用账号或重新授权。'
    if (e.status === 401)
      return host()?.initData
        ? '会话已失效，请从 Telegram 重新打开。'
        : '登录已失效，请刷新页面重新登录。'
    if (e.status === 404) return '收藏不存在或已删除。'
    if (e.status === 409) return '操作冲突，请刷新后重试。'
    if (e.status === 429) return '操作太频繁，请稍后重试。'
    if (e.status === 503) return '采集服务不可用。'
  }
  return e instanceof Error ? e.message : '加载失败。'
}
export const assetURL = (a: Asset, inline = true) =>
  (inline ? a.url : (a.download_url ?? a.url)) ?? ''
/** The small image for lists and avatars, or the original until one exists. */
export const previewURL = (a: Asset) => a.thumbnail_url ?? assetURL(a)
/** What Telegram's downloadFile needs: an absolute URL and a file name. */
export const telegramDownload = (a: Asset) => ({
  url: new URL(assetURL(a, false), location.href).href,
  file_name: a.file_name ?? a.id,
})
export function safeURL(value: string) {
  try {
    const u = new URL(value)
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined
  } catch {
    return
  }
}
