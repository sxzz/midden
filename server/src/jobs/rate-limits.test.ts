import { describe, expect, test } from 'vitest'
import { openDatabase } from '#db/client.ts'
import { rateLimits } from '#db/schema.ts'
import {
  activeRateLimits,
  limitedUntil,
  recordRateLimit,
} from './rate-limits.ts'

describe('rate limits', () => {
  test('hits within a limit count; its end only moves later; a new one starts over', () => {
    const db = openDatabase(':memory:')
    const hit = (until: number, now: number) =>
      recordRateLimit(db, { scope: 's', until, reason: 'HTTP 429' }, now)
    hit(60_000, 0)
    hit(30_000, 10_000)
    expect(db.select().from(rateLimits).all()).toEqual([
      {
        scope: 's',
        until: new Date(60_000),
        reason: 'HTTP 429',
        hits: 2,
        since: new Date(0),
      },
    ])
    expect(limitedUntil(db, 's', 59_999)).toBe(60_000)
    expect(limitedUntil(db, 's', 60_000)).toBeUndefined()
    expect(activeRateLimits(db, 60_000)).toEqual([])

    hit(200_000, 100_000)
    expect(activeRateLimits(db, 100_000)).toEqual([
      {
        scope: 's',
        until: new Date(200_000),
        reason: 'HTTP 429',
        hits: 1,
        since: new Date(100_000),
        waiting: 0,
      },
    ])
  })
})
