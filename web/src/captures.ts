import { groupLabel } from './presentation'
import type { CaptureMedia, CaptureRecord } from './api'

const LINK_SEPARATOR = /[\s<>"'，。；、（）]+/
const TRAILING_PUNCTUATION = /[),.;!?]+$/
const HTTP_SCHEME = /^https?:\/\//i
const BARE_LINK = /^[\w-]+(?:\.[\w-]+)+\/\S+$/
const WWW_PREFIX = /^www\./
const TRAILING_SLASH = /\/$/

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
}
const waitLabels: Record<NonNullable<CaptureRecord['waiting']>, string> = {
  queue: '排队中',
  retry: '等待重试',
}
/** The state of a single capture, such as one member of a collection. */
export function stateStatus(
  state: CaptureRecord['state'],
  waiting?: CaptureRecord['waiting'],
): RecordStatus {
  if (state === 'queued' && waiting)
    return { label: waitLabels[waiting] ?? '排队中', tone: 'active' }
  return stateLabels[state] ?? { label: state, tone: 'active' }
}

/** The state of a whole record, members included. */
export function recordStatus(r: CaptureRecord): RecordStatus {
  const m = r.members
  if (!m || r.state === 'failed' || r.state === 'queued')
    return stateStatus(r.state, r.waiting)
  if (!r.done) return { label: '正在保存帖子', tone: 'active' }
  if (r.stopped) return { label: '已中止', tone: 'warn' }
  return m.failed + m.partial > 0 || r.state === 'partial'
    ? { label: '部分缺失', tone: 'warn' }
    : { label: '已完成', tone: 'ok' }
}

/** Finished share between 0 and 1, or undefined while nothing is countable. */
export function recordProgress(r: CaptureRecord) {
  if (r.done) return 1
  const m = r.members
  if (m) {
    if (m.total) return (m.total - m.pending) / m.total
  } else if (r.state === 'downloading' && r.media.total)
    return (r.media.ready + r.media.failed) / r.media.total
}

/** Counts worth a line under the title; empty when there is nothing to count. */
export function recordCounts(r: CaptureRecord) {
  const m = r.members
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
