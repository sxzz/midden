import {
  isPostEntity,
  isProfileEntity,
  isProtected,
  profileVersion,
} from './relations'
import type { Asset, Collection, Entity } from './api'
export interface Stat {
  label: string
  value: string
}
export interface StatGroup {
  /** Names what the counts describe, so a post's numbers never read as its author's. */
  label: string
  items: Stat[]
}
export interface Detail {
  key: string
  label?: string
  value: string
  datetime?: string
}
export interface Presentation {
  profileCollectionId?: string
  name: string
  handle?: string
  avatar?: Asset
  /** Shown as a lock beside the name. */
  locked: boolean
  /** The author has a newer profile than this capture recorded. */
  profileChanged?: boolean
  body: string
  /** A profile's own bio, empty when it has none. */
  bio?: string
  /** Counts the source recorded for whatever the collection is about. */
  stats?: StatGroup
  /** What the source recorded about the item itself, read after the body. */
  details: Detail[]
}
export interface PresentOptions {
  /** Show the author as this capture recorded it, not as last seen. */
  captured?: boolean
}
type Presenter = (
  a: Collection,
  root?: Entity,
  options?: PresentOptions,
) => Presentation
const asText = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined
function details(
  a: Collection,
  published = a.published_at,
  edited?: string,
): Detail[] {
  const at = date(published)
  const editedAt = date(edited)
  return [
    ...(at
      ? [{ key: 'published', label: '发布于', value: at, datetime: published }]
      : []),
    ...(editedAt
      ? [{ key: 'edited', label: '已编辑', value: editedAt, datetime: edited }]
      : []),
  ]
}
const generic: Presenter = (a) => ({
  name: a.author_name || '已保存的内容',
  locked: a.visibility === 'private',
  body: a.text || a.summary || '暂无正文',
  details: details(a),
})
/** A count the source actually recorded. Zero is a reading; anything else is not. */
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value.toLocaleString('zh-CN')
    : undefined
type Fields = readonly (readonly [key: string, label: string])[]
function group(
  label: string,
  source: Record<string, unknown>,
  fields: Fields,
): StatGroup | undefined {
  const items = fields.flatMap(([key, name]) => {
    const value = count(source[key])
    return value === undefined ? [] : [{ label: name, value }]
  })
  return items.length ? { label, items } : undefined
}
// X counts these for one post, on the post itself. The two tables share a
// `likes` key and mean different things, which is why they read different
// entities: a post's reactions can never come from its author's profile.
const postCounts: Fields = [
  ['replies', '回复'],
  ['reposts', '转发'],
  ['likes', '点赞'],
  ['bookmarks', '书签'],
  ['quotes', '引用'],
]
// X keeps these for an account. Here `likes` counts the posts the account
// liked, so the app calls it 喜欢过.
const accountCounts: Fields = [
  ['followers', '关注者'],
  ['following', '正在关注'],
  ['statuses', '帖子'],
  ['media_count', '媒体'],
  ['likes', '喜欢过'],
]
function metadata(entity?: Entity): Record<string, unknown> {
  const value = entity?.data.metadata
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
function profileBio(a: Collection, profile?: Entity): string {
  const description = metadata(profile).description
  if (typeof description === 'string') return description.trim()
  // Older snapshots kept the handle as the first line of the collection text.
  const lines = (a.text || '').split(/\r?\n/)
  const handle = asText(profile?.data.username)
  if (handle && lines[0]?.trim() === `@${handle}`) lines.shift()
  return lines.join('\n').trim()
}
const social: Presenter = (a, root, options = {}) => {
  const key = a.graph?.relations.find(
    (r) => r.source === a.graph?.root && r.type === 'authored_by',
  )?.target
  const isProfile = isProfileEntity(root)
  const author = isProfile
    ? undefined
    : a.graph?.entities.find((e) => e.key === key && isProfileEntity(e))
  const profile = isProfile ? root : profileVersion(author, options.captured)
  const post = isPostEntity(root) ? root!.data : undefined
  const bio = isProfile ? profileBio(a, profile) : undefined
  const body = post ? (a.text?.trim() ? a.text : '') : generic(a).body
  return {
    ...generic(a),
    // The collection's own author line is the capture's; the profile may be newer.
    name: asText(profile?.data.name) || generic(a).name,
    body: bio === undefined ? body : bio || '暂无简介',
    bio,
    profileChanged: !!author?.current,
    // The lock follows the author's profile, not the visibility this capture
    // happened to have; that is only a fallback for snapshots that never
    // recorded protection.
    locked: isProtected(profile) ?? a.visibility === 'private',
    profileCollectionId: isProfile ? undefined : profile?.saved_collection_id,
    handle: asText(profile?.data.username),
    avatar: profile?.assets?.find(
      (v) => v.purpose === 'avatar' && v.state === 'ready',
    ),
    // Counts come from the entity the collection is about, and only that one.
    stats: isProfile
      ? group(
          '账号统计',
          metadata(profile),
          root?.type === 'instagram.profile'
            ? accountCounts.slice(0, 3)
            : accountCounts,
        )
      : post &&
        group(
          '帖子统计',
          post,
          root?.type === 'instagram.post'
            ? [
                ['replies', '评论'],
                ['likes', '点赞'],
              ]
            : postCounts,
        ),
    details: [
      ...details(
        a,
        asText(post?.published_at) ?? a.published_at,
        asText(post?.edited_at),
      ),
      ...(isProfile && root?.external_id
        ? [{ key: 'uid', label: 'UID', value: root.external_id }]
        : []),
      ...(a.id ? [{ key: 'uuid', label: 'UUID', value: a.id }] : []),
    ],
  }
}
const registry: Record<string, Presenter> = {
  'x.post': social,
  'x.profile': social,
  'instagram.post': social,
  'instagram.profile': social,
}
export function present(a: Collection, options?: PresentOptions) {
  const root = a.graph?.entities.find((e) => e.key === a.graph?.root)
  return (registry[root?.type || ''] || generic)(a, root, options)
}
/** What a refresh found about the source, for a line of its own. */
export function sourceStateNotice(a: Collection): string {
  if (!a.source_state) return ''
  const root = a.graph?.entities.find((e) => e.key === a.graph?.root)
  const profile = isProfileEntity(root)
  const label =
    a.source_state === 'suspended'
      ? profile
        ? '账号已被封禁'
        : '作者已被封禁'
      : profile
        ? '账号已不存在'
        : '原帖已删除'
  const at = date(a.source_state_at)
  return at ? `${label} · ${at} 发现` : label
}

function parseDate(value?: string) {
  if (!value) return
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : undefined
}
export function date(value?: string) {
  const d = parseDate(value)
  if (!d) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}
const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
function daysAgo(d: Date, now: Date) {
  return Math.round((+day(now) - +day(d)) / 86400000)
}
/** List timestamps read like the chat list: time today, date before that. */
export function shortDate(value?: string, now = new Date()) {
  const d = parseDate(value)
  if (!d) return ''
  const distance = daysAgo(d, now)
  if (distance === 0)
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  if (distance === 1) return '昨天'
  const date = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear()
    ? date
    : `${d.getFullYear()}年${date}`
}
/** Buckets the collection by when it was saved, newest bucket first. */
export function groupLabel(value?: string, now = new Date()) {
  const d = parseDate(value)
  if (!d) return '已保存'
  const distance = daysAgo(d, now)
  if (distance === 0) return '今天'
  if (distance === 1) return '昨天'
  const month = `${d.getMonth() + 1}月`
  return d.getFullYear() === now.getFullYear()
    ? month
    : `${d.getFullYear()}年${month}`
}
export interface CollectionGroup {
  label: string
  items: Collection[]
}
export function collectionTime(item: Collection, sort: string) {
  return sort === 'published' && parseDate(item.published_at)
    ? item.published_at
    : item.observed_at
}
export function groupCollections(
  items: Collection[],
  now = new Date(),
  sort?: string,
) {
  if (sort === 'storage')
    return items.length ? [{ label: '全部收藏', items }] : []
  const groups: CollectionGroup[] = []
  for (const item of items) {
    const label = groupLabel(
      sort ? collectionTime(item, sort) : item.saved_at || item.observed_at,
      now,
    )
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** Media that finished saving, in the order the source published it. */
export function readyMedia(assets: Asset[] = []) {
  return assets.filter((a) => a.state === 'ready')
}
/** Media state in words. Storage states never reach the reader. */
export function mediaNotice(asset: Asset) {
  if (asset.state === 'pending') return '媒体保存中'
  if (asset.state === 'failed') return '媒体保存失败'
  return '媒体无法打开'
}
const warnings: Record<string, string> = {
  'resource omitted: unsupported type or resource limit':
    '部分媒体超出限制，未保存。',
}
/** Adapter warnings are diagnostic strings; readers get plain wording. */
export function warningText(warning: string) {
  return warnings[warning] || '内容不完整。'
}
export function warningList(list?: string[] | null) {
  return [...new Set((list ?? []).map(warningText))]
}
/** One-paragraph preview for a list row. */
export function excerpt(text: string, limit = 120) {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function storageSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(1)} ${units[index]}`
}

export interface BodyPart {
  text: string
  href?: string
}
/** Only captured, saved profile identities become internal links. */
export function mentionParts(collection: Collection, text: string): BodyPart[] {
  const profiles = new Map<string, string>()
  for (const entity of collection.graph?.entities ?? []) {
    if (!isProfileEntity(entity) || !entity.saved_collection_id) continue
    const handle = asText(entity.data.username)
    if (handle) profiles.set(handle.toLowerCase(), entity.saved_collection_id)
  }
  const parts: BodyPart[] = []
  let offset = 0
  const root = collection.graph?.entities.find(
    (entity) => entity.key === collection.graph?.root,
  )
  const pattern = root?.type.startsWith('instagram.')
    ? /(?<![\w@./])@(\w(?:[\w.]{0,28}\w)?)(?![\w.])/g
    : /(?<![\w@./])@(\w{1,15})\b/g
  for (const match of text.matchAll(pattern)) {
    const id = profiles.get(match[1]!.toLowerCase())
    if (!id) continue
    if (match.index > offset)
      parts.push({ text: text.slice(offset, match.index) })
    parts.push({
      text: match[0],
      href: `#/collection/${encodeURIComponent(id)}`,
    })
    offset = match.index + match[0].length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts
}
