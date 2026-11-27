import { createHash } from 'node:crypto'
import * as v from 'valibot'
import { intervalUnits, type IntervalUnit } from '#db/schema.ts'
import { AppError } from '#errors.ts'

/** Every `count` `unit`s, e.g. every 6 hours, every month. */
export interface Interval {
  count: number
  unit: IntervalUnit
}

/**
 * The shortest interval: a watch runs often enough to follow an account,
 * not so often that it hammers the platforms or fills the archive with
 * captures that differ in nothing.
 */
export const MIN_INTERVAL_MS = 5 * 60_000
/** The largest count, in any unit. */
export const MAX_COUNT = 1000

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const FIXED: Partial<Record<IntervalUnit, number>> = {
  minute: MINUTE,
  hour: 60 * MINUTE,
  day: DAY,
  week: 7 * DAY,
}

/** The interval's length when it is a fixed one; months and years vary. */
export function fixedMs(interval: Interval): number | undefined {
  const unit = FIXED[interval.unit]
  return unit === undefined ? undefined : interval.count * unit
}

/** An interval in a request: `{"count": 6, "unit": "hour"}`. */
export const EveryBody = v.strictObject({
  count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_COUNT)),
  unit: v.picklist(intervalUnits),
})

export function checkInterval(interval: Interval): void {
  if (!intervalUnits.includes(interval.unit))
    throw new AppError('invalid_request', '间隔的单位无效')
  if (
    !Number.isSafeInteger(interval.count) ||
    interval.count < 1 ||
    interval.count > MAX_COUNT
  )
    throw new AppError('invalid_request', `间隔的数字须为 1 到 ${MAX_COUNT}`)
  const ms = fixedMs(interval)
  if (ms !== undefined && ms < MIN_INTERVAL_MS)
    throw new AppError('invalid_request', '间隔最短 5 分钟')
}

/** A time zone Temporal knows, or undefined. */
export function zoneOf(raw: string): string | undefined {
  if (!raw || raw.length > 64) return undefined
  try {
    return Temporal.Now.zonedDateTimeISO(raw).timeZoneId
  } catch {
    return undefined
  }
}

export function checkTimeZone(raw: string): string {
  const zone = zoneOf(raw)
  if (!zone) throw new AppError('invalid_request', '时区无效')
  return zone
}

/**
 * Where in its interval a watch's slots fall, fixed by its id: within the
 * whole interval when it has a fixed length, within the day for months and
 * years (a monthly watch runs on its day, at a time of its own).
 */
export function slotOffset(id: string, interval: Interval): number {
  // Ids made at about the same time share most of their characters: a
  // cryptographic hash spreads them evenly anyway.
  const hash = createHash('sha256').update(id).digest().readUInt32BE(0)
  return Math.floor((hash / 2 ** 32) * (fixedMs(interval) ?? DAY))
}

export interface Schedule {
  id: string
  every: Interval
  timeZone: string
  /** When the interval was set: months and years count from its local day. */
  anchorAt: number
}

/**
 * The watch's first slot after `now`. A fixed interval's slots are its
 * offset plus whole intervals (from 1970), so they never drift. Months and
 * years add to the local day of the anchor in the watch's time zone, each
 * slot from the anchor rather than from the slot before it: a watch anchored
 * on 31 January runs on the 28th or 29th of February, then on 31 March. The
 * time of day is the offset in local time, so it holds across DST.
 */
export function nextSlot(schedule: Schedule, now: number): number {
  const offset = slotOffset(schedule.id, schedule.every)
  const fixed = fixedMs(schedule.every)
  if (fixed !== undefined)
    return offset + (Math.floor((now - offset) / fixed) + 1) * fixed
  const zone = zoneOf(schedule.timeZone) ?? 'UTC'
  const local = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
  const anchor = local(schedule.anchorAt).toPlainDate()
  const time = Temporal.PlainTime.from({
    hour: Math.floor(offset / 3_600_000),
    minute: Math.floor(offset / MINUTE) % 60,
    second: Math.floor(offset / 1000) % 60,
  })
  const months =
    schedule.every.unit === 'year'
      ? schedule.every.count * 12
      : schedule.every.count
  const slot = (k: number) =>
    anchor
      .add({ months: k * months })
      .toZonedDateTime({ timeZone: zone, plainTime: time }).epochMilliseconds
  const since = anchor.until(local(now).toPlainDate(), {
    largestUnit: 'months',
  })
  let k = Math.max(0, Math.floor(since.months / months) - 1)
  while (slot(k) <= now) k++
  return slot(k)
}
