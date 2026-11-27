import { describe, expect, it } from 'vitest'
import { historyIn, storageTrends } from './storage'
import { formatTrendChange, formatValue, frame, geometry } from './trends'
import type { StorageDay } from './api'

const GiB = 2 ** 30
const day = (d: string, fields: Partial<StorageDay> = {}): StorageDay => ({
  day: d,
  r2: null,
  db_bytes: null,
  thumbnail_bytes: null,
  free_bytes: null,
  ...fields,
})

describe('storage history', () => {
  it('counts the range back from today', () => {
    const now = Date.parse('2026-11-26T08:00:00Z')
    const days = [
      day('2026-08-01'),
      day('2026-10-27'),
      day('2026-10-28'),
      day('2026-11-26'),
    ]
    expect(historyIn(days, '30', now).map((d) => d.day)).toEqual([
      '2026-10-28',
      '2026-11-26',
    ])
    expect(historyIn(days, '90', now)).toHaveLength(3)
    expect(historyIn(days, 'all', now)).toHaveLength(4)
  })

  it('draws a series read on two days or more, a day per point', () => {
    const bucket = (bytes: number | null) => ({
      bytes,
      objects: 1,
      class_a: 2,
      class_b: 3,
    })
    const trends = storageTrends(
      [
        day('2026-11-24', {
          r2: { midden: bucket(GiB), lone: bucket(1) },
          db_bytes: 2 * GiB,
        }),
        day('2026-11-25', { r2: { midden: bucket(null) } }),
        day('2026-11-26', {
          r2: { midden: bucket(2 * GiB) },
          db_bytes: 3 * GiB,
        }),
      ],
      true,
    )
    expect(trends.map((t) => [t.label, t.points.length])).toEqual([
      ['R2存储 · midden', 2],
      ['R2 Class A操作（每天）', 3],
      ['R2 Class B操作（每天）', 3],
      ['数据库文件', 2],
    ])
    expect(trends[1]!.points.map((p) => p.value)).toEqual([4, 2, 2])
    expect(storageTrends([day('2026-11-24'), day('2026-11-25')], true)).toEqual(
      [],
    )
    expect(
      storageTrends(
        [
          day('2026-11-24', { r2: { midden: bucket(GiB) } }),
          day('2026-11-25', { r2: { midden: bucket(GiB) } }),
        ],
        false,
      ),
    ).toEqual([])
  })

  it('writes sizes in bytes, on round ticks of their unit', () => {
    const [trend] = storageTrends(
      [
        day('2026-11-24', { db_bytes: 1.2 * GiB }),
        day('2026-11-26', { db_bytes: 2.3 * GiB }),
      ],
      false,
    )
    expect(formatValue(trend!, 2.3 * GiB)).toBe('2.3 GB')
    expect(formatTrendChange(trend!)).toBe('+1.1 GB')
    const ticks = geometry(trend!, frame(320, 132)).ticks.map((t) => t.label)
    expect(ticks).toEqual(['1 GB', '1.5 GB', '2 GB', '2.5 GB'])
  })
})
