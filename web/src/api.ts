import { host } from './host'
export interface Tag {
  id: string
  name: string
}
export interface Annotation {
  note: string
  tags: Tag[]
}
export interface Asset {
  id: string
  purpose?: string
  state: string
  mime?: string
  alt_text?: string
  sensitive: boolean
  error?: string
  /** A small derived image exists for lists; videos get their first frame. */
  thumbnail?: boolean
}
export interface Entity {
  external_id?: string
  saved_collection_id?: string
  /** The saved collection's current summary, for a post kept by reference. */
  saved_summary?: string
  key: string
  type: string
  data: Record<string, unknown>
  assets?: Asset[]
  /** An author's newest version, when it differs from this snapshot. */
  current?: { id: string; data: Record<string, unknown>; assets?: Asset[] }
}
export interface Collection {
  /** `author` is the profile the source snapshot attributes the entity to. */
  incoming_relations?: { type: string; entity: Entity; author?: Entity }[]
  relation_types?: string[]
  storage_bytes?: number
  id: string
  url: string
  text: string
  summary?: string
  author_name?: string
  published_at?: string
  saved_at?: string
  observed_at: string
  /** What the last refresh learned about the source itself. */
  source_state?: 'deleted' | 'suspended'
  source_state_at?: string
  visibility: string
  revision_id: string
  assets: Asset[]
  warnings?: string[] | null
  graph?: {
    root: string
    entities: Entity[]
    relations: { source: string; target: string; type: string }[]
  }
}
/** `id` is the stable adapter entity identity; `name` is only a label. */
export interface Author {
  id: string
  name: string
}
export interface Page<T> {
  total_storage_bytes?: number
  items: T[]
  next_cursor?: string
}
export interface Revision {
  id: string
  created_at: string
}
/** Captures a collection (such as a profile) started for its members. */
export interface MemberProgress {
  total: number
  complete: number
  partial: number
  failed: number
  pending: number
  done: boolean
}
export interface Job {
  id: string
  collection_id: string
  state: string
  error?: string
  members?: MemberProgress
}
/** What deleting everything would remove. */
export interface LibrarySize {
  collections: number
  records: number
  /** Records whose capture has not finished. */
  running: number
}
/** Images and videos of a record's own capture. */
export interface MediaProgress {
  total: number
  ready: number
  failed: number
}
/** One capture request: a saved link, a refresh, or a further page. */
export interface CaptureRecord {
  id: string
  job_id: string
  collection_id: string
  /** False once the collection left the library. */
  saved: boolean
  url: string
  input: string
  platform: string
  kind: string
  state: 'queued' | 'downloading' | 'complete' | 'partial' | 'failed'
  error?: string
  media: MediaProgress
  created_at: string
  finished_at?: string
  /** Set for a collection such as a profile, covering its members' captures. */
  members?: MemberProgress
  stopped?: boolean
  /** Failed members a finished collection record can fetch again. */
  retryable?: number
  /** What a finished collection record can fetch next, as the bot offers. */
  pages?: { more: boolean; more_1000: boolean; failed: boolean }
  /** The capture and every member capture have finished. */
  done: boolean
}
export interface CaptureMedia {
  position: number
  kind: string
  purpose?: string
  state: 'pending' | 'ready' | 'failed'
  error?: string
}
export interface CaptureRecordDetail extends CaptureRecord {
  warnings: string[]
  media_items: CaptureMedia[]
  /** Why members failed or were saved incompletely, most common first. */
  reasons: { reason: string; count: number }[]
}
export interface CaptureMember {
  job_id: string
  collection_id: string
  saved: boolean
  url: string
  state: CaptureRecord['state']
  error?: string
  reasons: string[]
  /** The source reported the content deleted or suspended. */
  gone?: boolean
  created_at: string
}
export interface Usage {
  used_bytes: number
  reserved_bytes: number
  limit_bytes: number
  unlimited: boolean
}
export interface AccountPlatform {
  id: string
  name: string
  help?: string
  /** Whether new captures can use the platform's public source. */
  public: boolean
  can_add: boolean
  /** Empty when the public source is selected. */
  selected_account_id?: string
}
export interface Account {
  id: string
  name: string
  username?: string
  state: string
  platform: string
  selected: boolean
}
export interface Accounts {
  platforms: AccountPlatform[]
  accounts: Account[]
}
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    // Ahead of images and video, which share the same connection.
    priority: 'high',
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new APIError(response.status, body.error || '服务暂时不可用')
  }
  return response.status === 204 ? (undefined as T) : response.json()
}
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
      return '此平台需要账号，请先添加并选择自己的采集凭据。'
    if (e.status === 422 && e.message.startsWith('account unavailable'))
      return '账号不可用，请在采集账号中选择可用账号或重新授权。'
    if (e.status === 401)
      return host()?.initData
        ? '会话已失效，请从 Telegram 重新打开。'
        : '登录已失效，请刷新页面重新登录。'
    if (e.status === 404) return '收藏不存在或已删除。'
    if (e.status === 409) return '存储空间不足或操作冲突。'
    if (e.status === 429) return '操作太频繁，请稍后重试。'
    if (e.status === 503) return '采集服务不可用。'
  }
  return e instanceof Error ? e.message : '加载失败。'
}
export const assetURL = (a: Asset, inline = true) =>
  `/v1/assets/${encodeURIComponent(a.id)}${inline ? '?inline=1' : ''}`
/** The small image for lists and avatars, or the original until one exists. */
export const previewURL = (a: Asset) =>
  a.thumbnail
    ? `/v1/assets/${encodeURIComponent(a.id)}/thumbnail?inline=1`
    : assetURL(a)
export function safeURL(value: string) {
  try {
    const u = new URL(value)
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined
  } catch {
    return
  }
}
