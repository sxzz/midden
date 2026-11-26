import { relationsDone, type ListProgress } from './follows'
import { groupLabel } from './presentation'
import type { CaptureMedia, CaptureRecord, ProfilePart } from './api'

const LINK_SEPARATOR = /[\s<>"'，。；、（）]+/
const TRAILING_PUNCTUATION = /[),.;!?]+$/
const HTTP_SCHEME = /^https?:\/\//i
const BARE_LINK = /^[\w-]+(?:\.[\w-]+)+\/\S+$/
const WWW_PREFIX = /^www\./
const TRAILING_SLASH = /\/$/
const WHOLE = /\.0$/

/**
 * Pull the links out of pasted text. A link may come without its scheme, the
 * way it is often copied from an address bar.
 */
export function extractLinks(text: string) {
  const links: string[] = []
  for (const token of text.split(LINK_SEPARATOR)) {
    const raw = token.replace(TRAILING_PUNCTUATION, '')
    const candidate = HTTP_SCHEME.test(raw)
      ? raw
      : BARE_LINK.test(raw)
        ? `https://${raw}`
        : ''
    if (!candidate || !URL.canParse(candidate)) continue
    if (!links.includes(candidate)) links.push(candidate)
  }
  return links
}

/** A link as a title: no scheme, query or trailing slash. */
export function linkTitle(value: string) {
  try {
    const url = new URL(value)
    return `${url.hostname.replace(WWW_PREFIX, '')}${url.pathname.replace(TRAILING_SLASH, '')}`
  } catch {
    return value
  }
}

export type Tone = 'active' | 'ok' | 'warn' | 'failed'
export interface RecordStatus {
  label: string
  tone: Tone
}
// A queued capture is being fetched unless the server says it waits.
const stateLabels: Record<CaptureRecord['state'], RecordStatus> = {
  queued: { label: '正在采集', tone: 'active' },
  downloading: { label: '正在保存媒体', tone: 'active' },
  complete: { label: '已完成', tone: 'ok' },
  partial: { label: '部分缺失', tone: 'warn' },
  failed: { label: '失败', tone: 'failed' },
  // An update's item it could not capture when its turn came.
  skipped: { label: '已跳过', tone: 'warn' },
}
const waitLabels: Record<NonNullable<CaptureRecord['waiting']>, string> = {
  queue: '排队中',
  retry: '等待重试',
  paused: '已暂停',
  rate_limit: '限流中',
}
/**
 * What a capture says that only found again what its source is known to be:
 * no failure, the archived content stays.
 */
const sourceStateLabels: Record<'deleted' | 'suspended', string> = {
  deleted: '原站已删除',
  suspended: '账号已被封禁',
}

/** The state of a single capture, such as one member of a collection. */
export function stateStatus(
  state: CaptureRecord['state'],
  waiting?: CaptureRecord['waiting'],
  sourceState?: 'deleted' | 'suspended',
): RecordStatus {
  if (sourceState) return { label: sourceStateLabels[sourceState], tone: 'ok' }
  if (state === 'queued' && waiting)
    return { label: waitLabels[waiting] ?? '排队中', tone: 'active' }
  return stateLabels[state] ?? { label: state, tone: 'active' }
}

/** The state of a whole record, members included. */
export function recordStatus(r: CaptureRecord): RecordStatus {
  if (r.update) {
    if (!r.done && (r.paused || r.paused_all))
      return { label: '已暂停', tone: 'warn' }
    if (!r.done) return { label: '正在更新', tone: 'active' }
    if (r.stopped) return { label: '已中止', tone: 'warn' }
    return stateStatus(r.state)
  }
  const m = r.members
  if (!m || r.state === 'failed' || r.state === 'queued')
    return stateStatus(r.state, r.waiting, r.source_state)
  if (!r.done)
    return {
      label:
        m.done && !relationsDone(r.relations) ? '正在抓关系网' : '正在保存帖子',
      tone: 'active',
    }
  if (r.stopped) return { label: '已中止', tone: 'warn' }
  return m.failed + m.partial > 0 || r.state === 'partial'
    ? { label: '部分缺失', tone: 'warn' }
    : { label: '已完成', tone: 'ok' }
}

/** Finished share between 0 and 1, or undefined while nothing is countable. */
export function recordProgress(r: CaptureRecord) {
  if (r.done) return 1
  const m = r.members
  if (r.update && m)
    return m.total ? (m.total - m.pending - r.update.queued) / m.total : 0
  // The lists that follow the posts have no share to show.
  if (m?.done) return
  if (m) {
    if (m.total) return (m.total - m.pending) / m.total
  } else if (r.state === 'downloading' && r.media.total)
    return (r.media.ready + r.media.failed) / r.media.total
}

/** Counts worth a line under the title; empty when there is nothing to count. */
export function recordCounts(r: CaptureRecord) {
  const m = r.members
  if (r.update && m)
    return [
      m.added && `新增 ${m.added}`,
      m.updated && `更新 ${m.updated}`,
      m.failed + m.partial && `异常 ${m.failed + m.partial}`,
      m.pending + r.update.queued && `进行中 ${m.pending + r.update.queued}`,
    ]
      .filter(Boolean)
      .join(' · ')
  if (m) {
    if (!m.total) return r.done ? '没有帖子' : ''
    return [
      `帖子 ${m.total - m.pending}/${m.total}`,
      m.added && `新增 ${m.added}`,
      m.updated && `更新 ${m.updated}`,
      m.partial && `不完整 ${m.partial}`,
      m.failed && `失败 ${m.failed}`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const added = r.added === undefined ? '' : r.added ? '新增' : '更新'
  if (!r.media.total) return added
  return [
    added,
    `媒体 ${r.media.ready}/${r.media.total}`,
    r.media.failed && `失败 ${r.media.failed}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * What the record did to the library: posts newly saved and ones refreshed.
 * Empty while unknown, e.g. for records older than this distinction.
 */
export function recordAdditions(r: CaptureRecord) {
  const m = r.members
  if (m) {
    if (!m.added && !m.updated) return ''
    return `新增 ${m.added ?? 0}，更新 ${m.updated ?? 0}`
  }
  if (r.added === undefined) return ''
  return r.added ? '新增到收藏' : '更新了已有收藏'
}

const purposes: Record<string, string> = {
  avatar: '头像',
  banner: '主页封面',
}
export function mediaLabel(m: CaptureMedia) {
  if (m.purpose && purposes[m.purpose]) return purposes[m.purpose]
  const kind = m.kind === 'video' ? '视频' : '图片'
  return m.purpose ? `${kind}（${m.purpose}）` : `${kind} ${m.position + 1}`
}
export const mediaStates: Record<CaptureMedia['state'], RecordStatus> = {
  pending: { label: '等待中', tone: 'active' },
  ready: { label: '已保存', tone: 'ok' },
  failed: { label: '失败', tone: 'failed' },
}

export function recordTime(value: string) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const day =
    d.getFullYear() === new Date().getFullYear()
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Records bucketed by the day or month they were made, like the library. */
export function groupRecords(items: CaptureRecord[], now = new Date()) {
  const groups: { label: string; items: CaptureRecord[] }[] = []
  for (const item of items) {
    const label = groupLabel(item.created_at, now)
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** A row's time under its group: the day is already in the group's title. */
export function recordRowTime(value: string, now = new Date()) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return ['今天', '昨天'].includes(groupLabel(value, now))
    ? time
    : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

/**
 * A profile as its handle, `@name`: the username when known, else the first
 * path segment of an X or Instagram profile link; otherwise the link.
 */
export function profileHandle(url: string, username?: string) {
  if (username) return `@${username}`
  try {
    const [name, ...rest] = new URL(url).pathname.split('/').filter(Boolean)
    if (name && !rest.length) return `@${name}`
  } catch {}
  return linkTitle(url)
}

/** A count the way the sheet reads it: 2.1 万 rather than 21000. */
export function countText(n: number) {
  if (n < 10_000) return String(n)
  return `${(Math.floor(n / 1000) / 10).toFixed(1).replace(WHOLE, '')} 万`
}

/** What a record is about: its link, or what its update covers. */
export function recordTitle(r: CaptureRecord) {
  const u = r.update
  if (!u) return linkTitle(r.url)
  // A watch's run (定期更新) says so.
  const update = u.watch ? '定期更新' : '更新'
  if (u.target === 'folder') return `${update}收藏夹「${u.name ?? ''}」`
  if (u.target === 'many') return `${update} ${u.posts + u.profiles} 项`
  if (!r.url) return update
  if (r.kind !== 'profile') return `${update} ${linkTitle(r.url)}`
  const handle = profileHandle(r.url, u.handle)
  return u.older ? `抓取 ${handle} 更早的帖子` : `${update} ${handle}`
}

/** What an update covers, e.g. 12 个账号、340 条帖子. */
export function coverText(posts: number, profiles: number) {
  return [profiles && `${profiles} 个账号`, posts && `${posts} 条帖子`]
    .filter(Boolean)
    .join('、')
}

const partMarks: Record<string, string> = {
  complete: '✓',
  partial: '✓',
  failed: '✗',
  skipped: '跳过',
  waiting: '等待中',
}

function listPart(r: ListProgress) {
  const name = r.list === 'following' ? '关注' : '粉丝'
  if (r.state === 'running' || r.state === 'waiting') return `${name} 进行中`
  if (r.state === 'failed') return `${name} 失败`
  return `${name} ${partMarks[r.state] ?? r.state}`
}

/** What the part texts read of a profile's part. */
type PartSummary = Pick<ProfilePart, 'state'> &
  Partial<Omit<ProfilePart, 'state' | 'posts' | 'relations'>> & {
    posts?: Pick<
      NonNullable<ProfilePart['posts']>,
      'total' | 'finished' | 'pending' | 'done' | 'capped'
    >
    relations?: readonly ListProgress[]
  }

/** The post cap stopped the timeline before saved posts; it can read on. */
export const canContinue = (p: PartSummary) => !!p.posts?.done && p.posts.capped

/**
 * How each part of a profile's update went, e.g.
 * 资料 ✓ · 帖子 34/100 · 关注 ✓ · 粉丝 跳过.
 */
export function profilePartText(p: PartSummary) {
  const parts = [`资料 ${partMarks[p.state] ?? '进行中'}`]
  if (p.posts && canContinue(p))
    parts.push(`帖子 ${p.posts.finished}（未到已有数据）`)
  else if (p.posts)
    parts.push(
      p.posts.done
        ? `帖子 ${p.posts.total}`
        : `帖子 ${p.posts.finished}/${p.posts.total}`,
    )
  for (const list of p.relations ?? []) parts.push(listPart(list))
  return parts.join(' · ')
}

/** A part of a profile a retry fetches again, and the id that names it. */
export interface RetryPart {
  id: string
  label: string
  detail: string
}

/**
 * The parts of a profile that failed or are incomplete and can be fetched
 * again, each on its own: its profile, each failed page of its posts, the
 * rest of its posts together, each list.
 */
export function retryParts(p: ProfilePart): RetryPart[] {
  const parts: RetryPart[] = []
  if (p.retryable && p.job_id)
    parts.push({
      id: p.job_id,
      label: '资料',
      detail: p.state === 'failed' ? '失败' : '不完整',
    })
  const pages = p.posts?.pages ?? []
  for (const page of pages)
    parts.push({
      id: page.id,
      label: `帖子第 ${page.number} 页`,
      detail: page.error || '失败',
    })
  const rest = (p.posts?.retryable ?? 0) - pages.length
  if (p.posts && rest > 0)
    parts.push({
      id: p.posts.retry_id,
      label: '帖子',
      detail: `失败或不完整 ${rest} 项`,
    })
  for (const list of p.relations ?? [])
    if (list.retryable)
      parts.push({
        id: list.id,
        label: list.list === 'following' ? '关注名单' : '粉丝名单',
        detail: list.error || (list.state === 'partial' ? '不完整' : '失败'),
      })
  return parts
}
