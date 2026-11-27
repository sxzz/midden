import {
  hc,
  type ClientResponse,
  type InferRequestType,
  type InferResponseType,
  type parseResponse,
} from 'hono/client'
import { host } from './host'
import { queryErrorText } from './query-errors'
import type { Api } from '@midden/server/api'

const TRAILING_SLASHES = /\/+$/
// A path on the same origin: one slash, not `//host`.
const SERVER_RELATIVE = /^\/(?!\/)/

/**
 * Where the API is, without a trailing slash: `VITE_API_URL` at build time
 * (`https://api.example.com`), or empty for the page's own origin
 * (the dev server's proxy, a server that serves the app itself).
 */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').replace(
  TRAILING_SLASHES,
  '',
)
/** The API's address as an agent is given it: always absolute. */
export const apiAddress = () => API_URL || location.origin

/** The server's `/v1` API, typed from its route definitions. */
export const client = hc<Api>(`${API_URL}/v1`, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    // Ahead of images and video, which share the same connection. The
    // session cookie is the API host's, sent to it from this origin too.
    fetch(input, {
      priority: 'high',
      ...init,
      credentials: API_URL ? 'include' : 'same-origin',
    }),
})

/**
 * The server's own links (signed media, `/media/…`) are relative to the
 * API, which may be on another origin than this page: they get its origin.
 */
function onAPI(key: string, value: unknown) {
  return API_URL &&
    typeof value === 'string' &&
    key.endsWith('url') &&
    SERVER_RELATIVE.test(value)
    ? API_URL + value
    : value
}

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
      code?: string
      kind?: string
      detail?: Record<string, string | number>
    }
    // A query it cannot run, in the app's words.
    if (body.code === 'query_invalid' && body.kind)
      throw new APIError(
        response.status,
        queryErrorText(body.kind, body.detail, body.error),
      )
    throw new APIError(response.status, body.error || '服务暂时不可用')
  }
  if (response.status === 204) return undefined as never
  return (
    API_URL ? JSON.parse(await response.text(), onAPI) : await response.json()
  ) as never
}

type Ok<T> = InferResponseType<T, 200>

export type Collection = Ok<(typeof client.collections)[':id']['$get']>
export type CollectionPage = Ok<typeof client.collections.$get>
export type Asset = Collection['assets'][number]
export type Entity = NonNullable<Collection['graph']>['entities'][number]
/** An author of the list; the owner's say how the query box names them. */
export type Author = Omit<
  Ok<typeof client.collections.authors.$get>['items'][number],
  'term'
> & { term?: string }
export type Perspective = Ok<
  typeof client.collections.perspectives.$get
>['items'][number]
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
export type FollowCounts = Ok<
  (typeof client.collections)[':id']['follows']['$get']
>
export type FollowChanges = Ok<
  (typeof client.collections)[':id']['follow-changes']['$get']
>
export type FollowChange = FollowChanges['items'][number]
export type FollowAccount = FollowChange['account']
export type FollowGraph = Ok<
  (typeof client.collections)[':id']['graph']['$get']
>
export type GraphNode = FollowGraph['nodes'][number]
export type RelationCompare = Ok<typeof client.collections.compare.$get>
export type CompareAccount = RelationCompare['accounts'][number]
export type CompareItem = RelationCompare['items'][number]
export type Job = Ok<(typeof client.jobs)[':id']['$get']>
/** How a capture's following or followers list fetch went (抓关系网). */
export type RelationProgress = NonNullable<Job['relations']>[number]
export type LibrarySize = Ok<typeof client.library.$get>
export type CaptureRecord = Ok<typeof client.captures.$get>['items'][number]
export type CaptureRecordDetail = Ok<(typeof client.captures)[':id']['$get']>
export type CaptureMedia = CaptureRecordDetail['media_items'][number]
/** What an update (更新) covers, on its record. */
export type UpdateInfo = NonNullable<CaptureRecord['update']>
/** One profile of an update and how each part of it went. */
export type ProfilePart = NonNullable<CaptureRecordDetail['profiles']>[number]
export type UpdateTarget = InferRequestType<
  typeof client.updates.$post
>['json']['target']
export type UpdatePreview = Ok<typeof client.updates.preview.$post>
/** 定期更新: a profile or a folder updated on a schedule. */
export type Watch = Ok<typeof client.watches.$get>['items'][number]
/** Every `count` `unit`s. */
export type WatchEvery = Watch['every']
export type IntervalUnit = WatchEvery['unit']
export type WatchTarget = Pick<
  InferRequestType<typeof client.watches.$put>['json'],
  'target' | 'id'
>
export type CollectionUpdate = Ok<
  (typeof client.collections)[':id']['update']['$get']
>
export type CaptureMember = Ok<
  (typeof client.captures)[':id']['members']['$get']
>['items'][number]
export type Usage = Ok<typeof client.usage.$get>
/** What removing media (删除媒体) does, from its dry run. */
export type RemovalEffect = Ok<(typeof client)['media-removals']['$post']>
export type RemovalTarget = InferRequestType<
  (typeof client)['media-removals']['$post']
>['json']
/** What 删除所有视频 of a profile does, from its dry run. */
export type VideoRemovalEffect = Ok<
  (typeof client.collections)[':id']['video-removal']['preview']['$post']
>
/** 删除所有视频 of a profile, as its job goes. */
export type VideoRemoval = NonNullable<
  Ok<(typeof client.collections)[':id']['video-removal']['$get']>['removal']
>
export type Accounts = Ok<typeof client.accounts.$get>
export type Account = Accounts['accounts'][number]
export type AccountPlatform = Accounts['platforms'][number]
export type Tag = Ok<typeof client.tags.$get>[number]
/** What became of an edited tag, for lists and filters that name it. */
export interface TagChange {
  /** The edited tag's id. */
  from: string
  /** The tag it now is: itself renamed, or the one it merged into. */
  to?: Tag
}
/** A folder as the admin has it: what it selects by, too. */
export type Folder = Ok<typeof client.folders.$post>
/**
 * A publicly shared folder as a viewer has it (`GET /v1/folders`, whose
 * type is the fields both have): no query or filter.
 */
export type SharedFolder = Ok<typeof client.folders.$get>[number]
/** A folder as `GET /v1/folders` lists it, for whoever asks. */
export type LibraryFolder = Folder | SharedFolder
/** Whether a listed folder says what it selects by (the admin's). */
export const isSaved = (folder: LibraryFolder): folder is Folder =>
  'filter' in folder
/** Who is signed in, and what the app may offer them. */
export type SessionInfo = Ok<typeof client.session.$get>
/** A user in 设置's 用户 (the admin's). */
export type AppUser = Ok<typeof client.users.$get>[number]
/** An invite still good. */
export type Invite = Ok<typeof client.invites.$get>[number]
export type Passkey = Ok<typeof client.passkeys.$get>[number]
/** A browser or Mini App signed in (已登录的设备). */
export type WebSession = Ok<typeof client.sessions.$get>[number]
/** An API token (API 令牌), with its use over the last 30 days. */
export type ApiToken = Ok<typeof client.tokens.$get>[number]
export type ApiTokenUsage = Ok<(typeof client.tokens)[':id']['usage']['$get']>
export type Instance = Ok<typeof client.instance.$get>
export type LitestreamStatus = Instance['litestream']
export type StorageReport = Ok<typeof client.storage.$get>
export type StorageAlerts = StorageReport['alerts']
export type StorageDay = StorageReport['history'][number]
export type QueueState = Ok<typeof client.queue.$get>
export type SlowQuery = Ok<
  (typeof client.queue)['slow-queries']['$get']
>['items'][number]
export type WebOrigin = Ok<typeof client.origins.$get>[number]
export type Share = Ok<typeof client.shares.$get>[number]
export type PublicShareInfo = Ok<(typeof client.public)[':slug']['$get']>
export type Annotation = Ok<
  (typeof client.collections)[':id']['annotation']['$get']
>
/** What a capture or an update does; the same for both. */
export type CaptureOptions = NonNullable<
  InferRequestType<typeof client.updates.$post>['json']['options']
>

/** What to tell the user about a failed call: the server words its errors. */
export function errorText(e: unknown) {
  if (e instanceof APIError && e.status === 401)
    return host()?.initData
      ? '会话已失效，请从Telegram重新打开。'
      : '登录已失效，请刷新页面重新登录。'
  return e instanceof Error ? e.message : '加载失败。'
}
export const assetURL = (a: Asset, inline = true) =>
  (inline ? a.url : (a.download_url ?? a.url)) ?? ''
/**
 * The small image for lists and avatars, or the original until one exists;
 * for an account image never saved here, the platform's own address.
 */
export const previewURL = (a: Asset) =>
  a.thumbnail_url ?? (a.url || a.remote_url || '')
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
