// 设置 → API 令牌: how a token's permission, expiry and use read.
import { date } from './presentation'
import type { ApiToken } from './api'

export const permissionLabels: Record<ApiToken['permission'], string> = {
  ro: '只读',
  rw: '读写',
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What the token form gives: a new token's, or an edit's. */
export interface TokenForm {
  label: string
  permission: ApiToken['permission']
  /** ISO time, or null for never. */
  expires_at: string | null
}

/** Quick picks that fill the expiry picker: from now. */
export const expiryPresets = [
  { label: '1 小时', ms: HOUR },
  { label: '1 天', ms: DAY },
  { label: '30 天', ms: 30 * DAY },
] as const

/** What a new token's picker starts at. */
export const DEFAULT_EXPIRY_MS = 30 * DAY

/** Time left, in the two largest units: 6 天 23 小时, 45 分钟. */
export function remaining(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now
  if (!(left > 0)) return '已过期'
  if (left < MINUTE) return '不到 1 分钟'
  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  if (days) return hours ? `${days} 天 ${hours} 小时` : `${days} 天`
  const minutes = Math.floor((left % HOUR) / MINUTE)
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  return `${minutes} 分钟`
}

/** The expiry in local time and what is left: 12月3日 14:00 过期 · 剩 7 天. */
export function expiryText(
  token: Pick<ApiToken, 'expires_at'>,
  now = Date.now(),
): string {
  if (!token.expires_at) return '永不过期'
  const left = remaining(token.expires_at, now)
  return left === '已过期'
    ? `${date(token.expires_at)} 已过期`
    : `${date(token.expires_at)} 过期 · 剩 ${left}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A time as a `datetime-local` field holds it: local, to the minute. */
export function localInput(at: number | Date): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A `datetime-local` field's value as an ISO time, if it holds one. */
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** A token's day counts as bars: each a share of the busiest day. */
export function usageBars(days: { day: string; count: number }[]) {
  const max = Math.max(1, ...days.map((d) => d.count))
  return days.map((d) => ({ ...d, share: d.count / max }))
}

/** 11-26 → 11月26日. */
export const dayLabel = (day: string) => {
  const [, month, date] = day.split('-', 3)
  return `${Number(month)}月${Number(date)}日`
}
