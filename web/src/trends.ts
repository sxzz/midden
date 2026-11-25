import { countFields, date, storageSize } from './presentation'
import type { CountsSeries } from './api'

/** One reading of a count: the capture that saw it, when, and the value. */
export interface TrendPoint {
  id: string
  at: number
  value: number
}
/** A count over time, oldest reading first, with at least two readings. */
export interface Trend {
  key: string
  label: string
  points: TrendPoint[]
  /** Sizes in bytes rather than counts. */
  unit?: 'bytes'
  /** One reading a day: inspecting one shows its day, without the time. */
  daily?: boolean
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * The counts worth drawing: each count the entity type names, with every
 * capture that read it. A count read fewer than twice has no trend to show,
 * so it is left out rather than drawn as a lone dot.
 */
export function trends(series?: Partial<CountsSeries>): Trend[] {
  const points = series?.points ?? []
  return countFields(series?.entity_type).flatMap(({ key, label, pointer }) => {
    const readings = points.flatMap((point) => {
      const value = point.counts[pointer]
      const at = Date.parse(point.observed_at)
      return isCount(value) && Number.isFinite(at)
        ? [{ id: point.capture_id, at, value }]
        : []
    })
    return readings.length > 1 ? [{ key, label, points: readings }] : []
  })
}

/** The newest reading less the oldest, over what the page shows. */
export const change = (trend: Trend) =>
  trend.points.at(-1)!.value - trend.points[0]!.value

const full = new Intl.NumberFormat('zh-CN')
const signed = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero' })
export const formatCount = (value: number) => full.format(value)
export const formatChange = (value: number) =>
  value ? signed.format(value) : '无变化'

/** A reading as its trend counts it. */
export const formatValue = (trend: Trend, value: number) =>
  trend.unit === 'bytes' ? storageSize(value) : formatCount(value)
/** The change over the page, as its trend counts it. */
export function formatTrendChange(trend: Trend) {
  const value = change(trend)
  if (trend.unit !== 'bytes' || !value) return formatChange(value)
  return `${value > 0 ? '+' : '−'}${storageSize(Math.abs(value))}`
}
/** When a reading was taken: the day alone for daily trends. */
export function readingTime(trend: Trend, at: number) {
  const d = new Date(at)
  return trend.daily
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : date(d.toISOString())
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
/** The binary unit the largest reading is shown in, as storageSize picks it. */
function byteUnit(top: number): [number, string] {
  let index = 0
  while (top >= 1024 ** (index + 1) && index < BYTE_UNITS.length - 1) index++
  return [1024 ** index, BYTE_UNITS[index]!]
}
/**
 * Axis labels stay short: in full while the axis stays below 10,000, then
 * every label in 万 (or 亿), with as many decimals as its step needs, so one
 * axis never mixes 9,500 with 1万.
 */
export function axisCount(value: number, top: number, by: number) {
  if (top < 10_000 || !value) return full.format(value)
  const [unit, name] = top >= 1e8 ? [1e8, '亿'] : [1e4, '万']
  const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(by / unit))))
  return `${(value / unit).toLocaleString('zh-CN', { maximumFractionDigits: decimals })}${name}`
}

const DAY = 86_400_000
/**
 * A date at the end of an axis: the time when the whole span is within a
 * day, otherwise the day, with the year when it is not this one.
 */
export function axisDate(at: number, span: number, now = new Date()) {
  const d = new Date(at)
  if (span < DAY)
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear()
    ? day
    : `${d.getFullYear()}年${day}`
}

/**
 * A round step that cuts `span` into about `count` parts; whole numbers only
 * unless `fractions` allows less than 1.
 */
function step(span: number, count: number, fractions = false) {
  const raw = span / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return fractions ? nice * magnitude : Math.max(1, nice * magnitude)
}

export interface ValueScale {
  min: number
  max: number
  /** The distance between ticks. */
  by: number
  ticks: number[]
}
/**
 * A value axis that fits the readings between round numbers. Counts change
 * little against their size, so it starts near the lowest reading, not at
 * zero. A count that never moved sits in the middle, between round ticks.
 */
export function valueScale(
  values: readonly number[],
  count = 3,
  fractions = false,
): ValueScale {
  const low = Math.min(...values)
  const high = Math.max(...values)
  let by: number, min: number, max: number
  if (low === high) {
    by = step(Math.max(fractions ? 0.2 : 2, high * 0.2), 2, fractions)
    min = Math.max(0, low - by)
    max = low + by
  } else {
    by = step(high - low, count, fractions)
    min = Math.floor(low / by) * by
    max = Math.ceil(high / by) * by
  }
  const ticks: number[] = []
  for (let tick = Math.ceil(min / by) * by; tick <= max; tick += by)
    ticks.push(tick)
  return { min, max, by, ticks }
}

/** Where the plot sits in a chart of a given size, in pixels. */
export interface Frame {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}
// Room for the value labels on the right and the dates below.
const GUTTER = 48
const AXIS = 22
// Half an end dot and its ring, so the first and last readings are not cut.
const INSET = 6
export function frame(width: number, height: number): Frame {
  return {
    width,
    height,
    left: INSET,
    right: Math.max(INSET + 1, width - GUTTER),
    top: INSET + 4,
    bottom: height - AXIS,
  }
}

export interface Geometry {
  /** Each reading's position, in the order of the trend's points. */
  xs: number[]
  ys: number[]
  /** The line through every reading. */
  path: string
  ticks: { value: number; y: number; label: string }[]
  start: string
  end: string
}
/** Time runs left to right at its real pace, so gaps between captures show. */
export function geometry(trend: Trend, box: Frame, now = new Date()): Geometry {
  const first = trend.points[0]!.at
  const span = trend.points.at(-1)!.at - first
  // Sizes are drawn in the unit of the largest, so ticks fall on round
  // numbers of it: 1.5 GB, 2 GB rather than 1,500,000,000.
  const [divisor, unit] =
    trend.unit === 'bytes'
      ? byteUnit(Math.max(...trend.points.map((p) => p.value)))
      : [1, '']
  const scale = valueScale(
    trend.points.map((p) => p.value / divisor),
    3,
    trend.unit === 'bytes',
  )
  const x = (at: number) =>
    span ? box.left + ((at - first) / span) * (box.right - box.left) : box.right
  const y = (value: number) =>
    box.bottom -
    ((value - scale.min) / (scale.max - scale.min)) * (box.bottom - box.top)
  const xs = trend.points.map((p) => x(p.at))
  const ys = trend.points.map((p) => y(p.value / divisor))
  const decimals = Math.min(3, Math.max(0, Math.ceil(-Math.log10(scale.by))))
  return {
    xs,
    ys,
    path: xs
      .map((px, i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${ys[i]!.toFixed(1)}`)
      .join(''),
    ticks: scale.ticks.map((value) => ({
      value,
      y: y(value),
      label: unit
        ? `${Number(value.toFixed(decimals))} ${unit}`
        : axisCount(value, scale.max, scale.by),
    })),
    start: axisDate(first, span, now),
    end: axisDate(first + span, span, now),
  }
}

/** The reading nearest to `px` along the time axis. */
export function nearest(xs: readonly number[], px: number): number {
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! < px) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && px - xs[lo - 1]! <= xs[lo]! - px ? lo - 1 : lo
}

/** Every capture with a reading, newest first, for the table view. */
export function tableRows(list: readonly Trend[]) {
  const rows = new Map<string, { id: string; at: number; values: string[] }>()
  list.forEach((trend, column) => {
    for (const point of trend.points) {
      let row = rows.get(point.id)
      if (!row) {
        row = { id: point.id, at: point.at, values: list.map(() => '') }
        rows.set(point.id, row)
      }
      row.values[column] = formatCount(point.value)
    }
  })
  return [...rows.values()].toSorted((a, b) => b.at - a.at)
}
