import { groupLabel } from './presentation'
import type { CaptureMedia, CaptureRecord } from './api'

/**
 * Pull the links out of pasted text. A link may come without its scheme, the
 * way it is often copied from an address bar.
 */
export function extractLinks(text: string) {
  const links: string[] = []
  for (const token of text.split(/[\s<>"'，。；、（）]+/)) {
    const raw = token.replace(/[),.;!?]+$/, '')
    const candidate = /^https?:\/\//i.test(raw)
      ? raw
      : /^[\w-]+(?:\.[\w-]+)+\/\S+$/.test(raw)
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
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return value
  }
}

export type Tone = 'active' | 'ok' | 'warn' | 'failed'
export interface RecordStatus {
  label: string
  tone: Tone
}
const stateLabels: Record<CaptureRecord['state'], RecordStatus> = {
  queued: { label: '排队中', tone: 'active' },
  downloading: { label: '正在保存媒体', tone: 'active' },
  complete: { label: '已完成', tone: 'ok' },
  partial: { label: '部分缺失', tone: 'warn' },
  failed: { label: '失败', tone: 'failed' },
}
/** The state of a single capture, such as one member of a collection. */
export const stateStatus = (state: CaptureRecord['state']): RecordStatus =>
  stateLabels[state] ?? { label: state, tone: 'active' }

/** The state of a whole record, members included. */
export function recordStatus(r: CaptureRecord): RecordStatus {
  const m = r.members
  if (!m || r.state === 'failed' || r.state === 'queued')
    return stateStatus(r.state)
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
      m.partial && `不完整 ${m.partial}`,
      m.failed && `失败 ${m.failed}`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (!r.media.total) return ''
  return [
    `媒体 ${r.media.ready}/${r.media.total}`,
    r.media.failed && `失败 ${r.media.failed}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const reasons: Record<string, string> = {
  'storage quota exceeded': '存储配额不足',
  'account cannot access this post': '采集账号无权访问该帖子',
  'account is suspended': '账号已被封禁，解封后可重新抓取',
  'profile not found': '账号不存在或已改名',
  'post not found or deleted': '帖子不存在或已删除',
  'provider cannot access this post': '无法获取该帖子',
  'provider cannot access this profile': '无法获取该账号资料',
  'account required; add and select your own credentials':
    '此平台需要账号，请先添加并选择自己的采集凭据',
  'Instagram requires an account; select an Instagram account and retry':
    'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
  'Instagram requires login':
    'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
  'Instagram session expired; authorize again':
    'Instagram 登录已失效，请重新添加账号授权',
  'Instagram rate limited the request': 'Instagram 请求过于频繁，请稍后重试',
  'Instagram content not found or inaccessible':
    'Instagram 内容不存在或当前账号无权访问',
  'Instagram temporarily unavailable': 'Instagram 暂时不可用，请稍后重试',
  'provider temporarily unavailable': '来源平台暂时不可用，请稍后重试',
  'account request signing unavailable': '采集账号请求签名不可用',
  'context deadline exceeded': '请求超时',
  'job exhausted retries or was interrupted': '任务重试次数已用尽或执行被中断',
  'capture was interrupted': '采集被中断',
  'operation failed; retry or inspect service health': '服务内部错误',
  'resource omitted: unsupported type or resource limit':
    '部分资源类型不支持或资源数量超过限制',
}
/** A failure reason as the bot words it; unknown ones are shown as recorded. */
export function reasonText(reason: string) {
  const text = reason.trim()
  if (
    /^Instagram (?:access denied|requires browser|redirected|requires login, )/.test(
      text,
    )
  )
    return 'Instagram 要求登录验证或账号无权访问，请检查账号后重试'
  return reasons[text] ?? text
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
