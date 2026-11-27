// 设置 → 通行密钥 → 已登录的设备: how a session reads.
import { date } from './presentation'
import type { WebSession } from './api'

export const signInLabels: Record<NonNullable<WebSession['method']>, string> = {
  passkey: '通行密钥',
  telegram: 'Telegram Mini App',
}

/** The device it signed in on, as the server read its user agent. */
export const deviceName = (s: Pick<WebSession, 'device'>) =>
  s.device ?? '未知设备'

const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0)

/**
 * When it was last used, by local day: 今天, 昨天, 3 天前. The server
 * writes it at most once a day, so a day is all it says.
 */
export function lastUsed(at: string, now = Date.now()): string {
  const days = Math.max(
    0,
    Math.round((startOfDay(now) - startOfDay(Date.parse(at))) / 86_400_000),
  )
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/** The line under its name: domain, how, last used, signed in. */
export function sessionDetails(s: WebSession, now = Date.now()): string {
  return [
    s.origin ? new URL(s.origin).host : '',
    s.method ? signInLabels[s.method] : '',
    s.current ? '' : `最近使用：${lastUsed(s.last_used_at, now)}`,
    `登录于 ${date(s.created_at)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}
