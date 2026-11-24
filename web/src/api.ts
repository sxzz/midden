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
export type HistoryPoint = Ok<
  (typeof client.collections)[':id']['history']['$get']
>['items'][number]
export type CountsSeries = Ok<
  (typeof client.collections)[':id']['counts']['$get']
>
export type ProfileChanges = Ok<
  (typeof client.collections)[':id']['profile-changes']['$get']
>
export type ProfileChange = ProfileChanges['items'][number]
export type ProfileFieldChange = ProfileChange['fields'][number]
export type Job = Ok<(typeof client.jobs)[':id']['$get']>
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
export type Folder = Ok<typeof client.folders.$get>[number]
export type Share = Ok<typeof client.shares.$get>[number]
export type PublicShareInfo = Ok<(typeof client.public)[':slug']['$get']>
export type Annotation = Ok<
  (typeof client.collections)[':id']['annotation']['$get']
>
export type CaptureOptions = NonNullable<
  Extract<
    InferRequestType<typeof client.captures.$post>['json'],
    { url: string }
  >['options']
>

/** What to tell the user about a failed call: the server words its errors. */
export function errorText(e: unknown) {
  if (e instanceof APIError && e.status === 401)
    return host()?.initData
      ? '会话已失效，请从 Telegram 重新打开。'
      : '登录已失效，请刷新页面重新登录。'
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
