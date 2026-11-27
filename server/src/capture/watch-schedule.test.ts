import { describe, expect, test } from 'vitest'
import {
  checkInterval,
  fixedMs,
  nextSlot,
  slotOffset,
  type Interval,
  type Schedule,
} from './watch-schedule.ts'
import type { IntervalUnit } from '#db/schema.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ID = '0b8f3d4e-6f1a-4c55-9d1e-2f7a8b9c0d11'
const START = Date.parse('2026-11-26T00:00:00Z')

const every = (count: number, unit: IntervalUnit): Interval => ({
  count,
  unit,
})
const schedule = (
  interval: Interval,
  patch: Partial<Schedule> = {},
): Schedule => ({
  id: ID,
  every: interval,
  timeZone: 'UTC',
  anchorAt: START,
  ...patch,
})
/** The local wall time of an instant, as `2026-02-28T05:12:33`. */
const local = (ms: number, zone: string) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })

describe('fixed intervals', () => {
  test.each([
    [every(5, 'minute'), 5 * MINUTE],
    [every(90, 'minute'), 90 * MINUTE],
    [every(6, 'hour'), 6 * HOUR],
    [every(1, 'day'), DAY],
    [every(3, 'day'), 3 * DAY],
    [every(2, 'week'), 14 * DAY],
  ])('%o: its slots are its length apart, from its own offset', (i, ms) => {
    expect(fixedMs(i)).toBe(ms)
    const offset = slotOffset(ID, i)
    expect(offset).toBe(slotOffset(ID, i))
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(offset).toBeLessThan(ms)
    const first = nextSlot(schedule(i), START)
    expect(first).toBeGreaterThan(START)
    expect(first - START).toBeLessThanOrEqual(ms)
    expect((first - offset) % ms).toBe(0)
    // Exactly at a slot, the next one is a whole interval on.
    expect(nextSlot(schedule(i), first)).toBe(first + ms)
    expect(nextSlot(schedule(i), first - 1)).toBe(first)
  })

  test('the old choices keep their slots: 6 hours, 1 day, 1 week', () => {
    // As `6h`, `daily` and `weekly` placed them: the offset is a share of
    // the same length.
    for (const [i, ms] of [
      [every(6, 'hour'), 6 * HOUR],
      [every(1, 'day'), DAY],
      [every(1, 'week'), 7 * DAY],
    ] as const) {
      const offset = slotOffset(ID, i)
      expect(nextSlot(schedule(i), START)).toBe(
        offset + (Math.floor((START - offset) / ms) + 1) * ms,
      )
    }
  })

  test('watches spread over the interval rather than start together', () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    )
    const hours = new Set(
      ids.map((id) => Math.floor(slotOffset(id, every(6, 'hour')) / HOUR)),
    )
    // Forty watches land in every hour of the six.
    expect(hours.size).toBe(6)
    const offsets = new Set(ids.map((id) => slotOffset(id, every(1, 'day'))))
    expect(offsets.size).toBe(ids.length)
  })

  test('a day is 24 hours, whatever the zone', () => {
    const zoned = schedule(every(1, 'day'), { timeZone: 'America/New_York' })
    // Across the end of DST in New York (1 November 2026).
    const before = Date.parse('2026-10-31T00:00:00Z')
    const first = nextSlot(zoned, before)
    expect(nextSlot(zoned, first)).toBe(first + DAY)
  })
})

describe('months and years', () => {
  test('a month counts from the anchor day, at a time of its own within the day', () => {
    const monthly = schedule(every(1, 'month'), {
      anchorAt: Date.parse('2026-11-10T15:00:00Z'),
    })
    const offset = slotOffset(ID, every(1, 'month'))
    expect(offset).toBeLessThan(DAY)
    const slots = [nextSlot(monthly, Date.parse('2026-11-10T15:00:00Z'))]
    for (let i = 0; i < 3; i++) slots.push(nextSlot(monthly, slots.at(-1)!))
    const days = slots.map((ms) => local(ms, 'UTC').slice(0, 10))
    const times = new Set(slots.map((ms) => local(ms, 'UTC').slice(11)))
    // The offset decides whether the anchor day itself still has its slot.
    expect(days.slice(-3)).toEqual(
      offset > 15 * HOUR
        ? ['2026-12-10', '2027-01-10', '2027-02-10']
        : ['2027-01-10', '2027-02-10', '2027-03-10'],
    )
    expect(times.size).toBe(1)
    // The slot's time is the offset, never later than a day after the date.
    const at = Date.parse(`${days[1]}T00:00:00Z`)
    expect(slots[1]! - at).toBe(Math.floor(offset / 1000) * 1000)
  })

  test('the end of a month: 31 January, then the last of February, then 31 March', () => {
    const monthly = schedule(every(1, 'month'), {
      anchorAt: Date.parse('2027-01-31T00:00:00Z'),
    })
    const slots = [nextSlot(monthly, Date.parse('2027-01-31T00:00:00Z'))]
    while (slots.length < 4) slots.push(nextSlot(monthly, slots.at(-1)!))
    expect(slots.map((ms) => local(ms, 'UTC').slice(0, 10))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ])
    // In a leap year, the 29th.
    const leap = schedule(every(1, 'month'), {
      anchorAt: Date.parse('2028-01-31T00:00:00Z'),
    })
    expect(
      local(nextSlot(leap, Date.parse('2028-02-01T00:00:00Z')), 'UTC'),
    ).toMatch(/^2028-02-29T/)
  })

  test('every 3 months, and every year from 29 February', () => {
    const quarterly = schedule(every(3, 'month'), {
      anchorAt: Date.parse('2026-01-15T00:00:00Z'),
    })
    expect(
      local(nextSlot(quarterly, Date.parse('2026-05-01T00:00:00Z')), 'UTC'),
    ).toMatch(/^2026-07-15T/)
    const yearly = schedule(every(1, 'year'), {
      anchorAt: Date.parse('2028-02-29T00:00:00Z'),
    })
    const first = nextSlot(yearly, Date.parse('2028-03-01T00:00:00Z'))
    expect(local(first, 'UTC')).toMatch(/^2029-02-28T/)
    expect(local(nextSlot(yearly, first), 'UTC')).toMatch(/^2030-02-28T/)
    // Each from the anchor: back on the 29th in the next leap year.
    expect(
      local(nextSlot(yearly, Date.parse('2031-03-01T00:00:00Z')), 'UTC'),
    ).toMatch(/^2032-02-29T/)
  })

  test("in the owner's time zone, at the same local time across DST", () => {
    const zone = 'America/New_York'
    // Anchored on the local 15 January, which is the 16th in UTC.
    const monthly = schedule(every(1, 'month'), {
      timeZone: zone,
      anchorAt: Date.parse('2027-01-16T03:00:00Z'),
    })
    const feb = nextSlot(monthly, Date.parse('2027-02-01T00:00:00Z'))
    const apr = nextSlot(monthly, Date.parse('2027-04-01T00:00:00Z'))
    expect(local(feb, zone).slice(0, 10)).toBe('2027-02-15')
    expect(local(apr, zone).slice(0, 10)).toBe('2027-04-15')
    // The same wall clock in EST and EDT, so an hour apart in UTC.
    expect(local(feb, zone).slice(11)).toBe(local(apr, zone).slice(11))
    expect((apr - feb) % DAY).toBe(23 * HOUR)
  })

  test('long after the anchor, the next slot is still the next one', () => {
    const monthly = schedule(every(1, 'month'))
    const later = Date.parse('2030-06-20T12:00:00Z')
    const next = nextSlot(monthly, later)
    expect(next).toBeGreaterThan(later)
    expect(local(next, 'UTC').slice(0, 10)).toMatch(/^2030-0[67]-26$/)
  })
})

describe('limits', () => {
  test('at least 5 minutes, at most 1000 of a unit, the units listed', () => {
    expect(() => checkInterval(every(4, 'minute'))).toThrow('间隔最短 5 分钟')
    expect(() => checkInterval(every(5, 'minute'))).not.toThrow()
    expect(() => checkInterval(every(1, 'hour'))).not.toThrow()
    expect(() => checkInterval(every(1000, 'year'))).not.toThrow()
    expect(() => checkInterval(every(1001, 'day'))).toThrow('1 到 1000')
    expect(() => checkInterval(every(0, 'day'))).toThrow('1 到 1000')
    expect(() => checkInterval(every(1.5, 'day'))).toThrow('1 到 1000')
    expect(() =>
      checkInterval({ count: 1, unit: 'fortnight' as IntervalUnit }),
    ).toThrow('间隔的单位无效')
  })
})
