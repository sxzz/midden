import { formatCount, type Trend } from './trends'
import type { StorageDay } from './api'

/** How far back 趋势 looks. */
export type HistoryRange = '30' | '90' | 'all'
export const HISTORY_RANGES: { value: HistoryRange; label: string }[] = [
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: 'all', label: '全部' },
]

const DAY = 86_400_000
/** A UTC day placed at its noon, so it reads as that day in any zone. */
const dayAt = (day: string) => Date.parse(`${day}T12:00:00Z`)

/** The days within the range, counted back from today (UTC) included. */
export function historyIn(
  days: readonly StorageDay[],
  range: HistoryRange,
  now = Date.now(),
): StorageDay[] {
  if (range === 'all') return [...days]
  const since = new Date(now - (Number(range) - 1) * DAY)
    .toISOString()
    .slice(0, 10)
  return days.filter((d) => d.day >= since)
}

function series(
  key: string,
  label: string,
  days: readonly StorageDay[],
  read: (day: StorageDay) => number | null | undefined,
  unit?: 'bytes',
): Trend[] {
  const points = days.flatMap((d) => {
    const value = read(d)
    return typeof value === 'number'
      ? [{ id: d.day, at: dayAt(d.day), value }]
      : []
  })
  return points.length > 1
    ? [{ key, label, points, daily: true, ...(unit ? { unit } : {}) }]
    : []
}

/**
 * The charts of 趋势: each bucket's storage and the day's operations when
 * R2 figures are shown, then the local disk. A series read on fewer than
 * two days has nothing to draw and is left out.
 */
export function storageTrends(
  days: readonly StorageDay[],
  withR2: boolean,
): Trend[] {
  const buckets = [
    ...new Set(days.flatMap((d) => Object.keys(d.r2 ?? {}))),
  ].toSorted()
  const sum = (d: StorageDay, field: 'class_a' | 'class_b') =>
    d.r2 ? Object.values(d.r2).reduce((n, b) => n + b[field], 0) : null
  return [
    ...(withR2
      ? [
          ...buckets.flatMap((bucket) =>
            series(
              `r2:${bucket}`,
              `R2存储 · ${bucket}`,
              days,
              (d) => d.r2?.[bucket]?.bytes,
              'bytes',
            ),
          ),
          ...series('class-a', 'R2 Class A操作（每天）', days, (d) =>
            sum(d, 'class_a'),
          ),
          ...series('class-b', 'R2 Class B操作（每天）', days, (d) =>
            sum(d, 'class_b'),
          ),
        ]
      : []),
    ...series('db', '数据库文件', days, (d) => d.db_bytes, 'bytes'),
    ...series('thumbnails', '缩略图', days, (d) => d.thumbnail_bytes, 'bytes'),
    ...series('free', '可用磁盘', days, (d) => d.free_bytes, 'bytes'),
  ]
}

export const usd = (value: number) => `$${value.toFixed(2)}`
export const times = (value: number) => `${formatCount(value)}次`
/** Operations in 万: 100 万次 rather than 1,000,000 次. */
export const tenThousands = (value: number) =>
  `${formatCount(value / 10_000)}万次`
export const gbMonths = (value: number) =>
  `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} GB·月`
/** What share of the free tier is used. */
export const share = (used: number, free: number) =>
  `${Math.round((used / free) * 100)}%`
