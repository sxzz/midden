import { describe, expect, it } from 'vitest'
import {
  dayLabel,
  expiryText,
  fromLocalInput,
  localInput,
  remaining,
  usageBars,
} from './tokens'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (ms: number) => new Date(NOW + ms).toISOString()

describe('API 令牌', () => {
  it('says how long a token has left, in its two largest units', () => {
    expect(remaining(at(6 * DAY + 3 * HOUR + 5 * MINUTE), NOW)).toBe(
      '6 天 3 小时',
    )
    expect(remaining(at(2 * DAY + 30 * MINUTE), NOW)).toBe('2 天')
    expect(remaining(at(5 * HOUR + 20 * MINUTE), NOW)).toBe('5 小时 20 分钟')
    expect(remaining(at(45 * MINUTE + 10_000), NOW)).toBe('45 分钟')
    expect(remaining(at(20_000), NOW)).toBe('不到 1 分钟')
    expect(remaining(at(0), NOW)).toBe('已过期')
    expect(remaining(at(-DAY), NOW)).toBe('已过期')
  })

  it('writes the expiry in local time with what is left', () => {
    expect(expiryText({ expires_at: null }, NOW)).toBe('永不过期')
    expect(expiryText({ expires_at: at(DAY) }, NOW)).toMatch(
      /^2026年11月27日 .+ 过期 · 剩 1 天$/,
    )
    expect(expiryText({ expires_at: at(-HOUR) }, NOW)).toMatch(/ 已过期$/)
  })

  it('fills and reads the date-time field in local time', () => {
    const local = localInput(new Date(2026, 10, 26, 9, 5, 30))
    expect(local).toBe('2026-11-26T09:05')
    expect(fromLocalInput(local)).toBe(
      new Date(2026, 10, 26, 9, 5).toISOString(),
    )
    expect(fromLocalInput('')).toBeUndefined()
    expect(fromLocalInput('not a time')).toBeUndefined()
  })

  it('scales days to the busiest one', () => {
    expect(
      usageBars([
        { day: '2026-11-25', count: 0 },
        { day: '2026-11-26', count: 4 },
        { day: '2026-11-27', count: 2 },
      ]).map((d) => d.share),
    ).toEqual([0, 1, 0.5])
    expect(usageBars([{ day: '2026-11-26', count: 0 }])[0]!.share).toBe(0)
    expect(dayLabel('2026-01-05')).toBe('1月5日')
  })
})
