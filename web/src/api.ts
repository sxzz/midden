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
}
export interface Entity {
  external_id?: string
  saved_collection_id?: string
  key: string
  type: string
  data: Record<string, unknown>
  assets?: Asset[]
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
export type UpdateMode = 'append' | 'full'
/** Progress of one background refresh of many saved collections. */
export interface RefreshBatch {
  id: string
  state: 'running' | 'complete' | 'failed'
  error?: string
  update_mode: UpdateMode
  total: number
  submitted: number
  /** Submissions answered by existing content, skipping the fetch. */
  reused: number
  rejected: number
  running: number
  complete: number
  partial: number
  failed: number
}
export interface Usage {
  used_bytes: number
  reserved_bytes: number
  limit_bytes: number
  unlimited: boolean
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
      return '筛选条件无效，请检查关键词和日期范围。'
    if (e.status === 400 && e.message === 'invalid note or tags')
      return '请检查备注长度（最多 10000 字）、标签名称（最多 64 字）和标签数量（最多 100 个）。'
    if (e.status === 401) return '会话已失效，请关闭后从 Telegram 重新打开。'
    if (e.status === 404) return '收藏不存在或已从收藏中删除。'
    if (e.status === 409) return '存储空间不足或操作冲突，请检查用量后重试。'
    if (e.status === 429) return '操作太频繁，请稍后重试。'
    if (e.status === 503) return '采集服务暂时不可用，请稍后重试。'
  }
  return e instanceof Error ? e.message : '加载失败，请重试。'
}
export const assetURL = (a: Asset, inline = true) =>
  `/v1/assets/${encodeURIComponent(a.id)}${inline ? '?inline=1' : ''}`
export function safeURL(value: string) {
  try {
    const u = new URL(value)
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined
  } catch {
    return
  }
}
