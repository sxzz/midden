import { describe, expect, it } from 'vitest'
import {
  axisCount,
  axisDate,
  change,
  formatChange,
  frame,
  geometry,
  nearest,
  tableRows,
  trends,
  valueScale,
  type Trend,
} from './trends'
import type { CountsSeries } from './api'

const point = (
  id: string,
  observed_at: string,
  counts: Record<string, number>,
) => ({ capture_id: id, observed_at, counts })

describe('trends', () => {
  it('draws each count of the entity read at least twice, named as the page names it', () => {
    const series: CountsSeries = {
      entity_type: 'x.profile',
      points: [
        point('c1', '2026-11-01T00:00:00Z', {
          '/metadata/followers': 100,
          '/metadata/following': 5,
          '/metadata/likes': 7,
        }),
        point('c2', '2026-11-02T00:00:00Z', {
          '/metadata/followers': 120,
          '/metadata/likes': 9,
        }),
        point('c3', '2026-11-03T00:00:00Z', {
          '/metadata/followers': 90,
          '/metadata/likes': 9,
        }),
      ],
    }
    const list = trends(series)
    // In the detail page's order; 正在关注 was read once and has no line.
    expect(list.map((t) => [t.key, t.label])).toEqual([
      ['followers', '关注者'],
      ['likes', '喜欢过'],
    ])
    expect(list[0]!.points).toEqual([
      { id: 'c1', at: Date.parse('2026-11-01T00:00:00Z'), value: 100 },
      { id: 'c2', at: Date.parse('2026-11-02T00:00:00Z'), value: 120 },
      { id: 'c3', at: Date.parse('2026-11-03T00:00:00Z'), value: 90 },
    ])
    expect(change(list[0]!)).toBe(-10)
    expect(change(list[1]!)).toBe(2)
  })

  it('reads a post’s counts on the post, and nothing it cannot name', () => {
    const counts = { '/likes': 3, '/replies': 1, '/views': 9 }
    const points = [
      point('c1', '2026-11-01T00:00:00Z', counts),
      point('c2', '2026-11-02T00:00:00Z', counts),
    ]
    expect(
      trends({ entity_type: 'x.post', points }).map((t) => t.label),
    ).toEqual(['回复', '点赞'])
    expect(
      trends({ entity_type: 'instagram.post', points }).map((t) => t.label),
    ).toEqual(['评论', '点赞'])
    expect(trends({ entity_type: 'fake.post', points })).toEqual([])
    expect(trends({ points: [] })).toEqual([])
    // A mock or older server may answer without points at all.
    expect(trends({} as CountsSeries)).toEqual([])
    expect(trends()).toEqual([])
  })
})

describe('formatting', () => {
  it('signs changes and says when there was none', () => {
    expect(formatChange(1234)).toBe('+1,234')
    expect(formatChange(-5)).toBe('-5')
    expect(formatChange(0)).toBe('无变化')
  })

  it('keeps axis numbers short past ten thousand, alike on one axis', () => {
    expect(axisCount(9500, 9999, 500)).toBe('9,500')
    expect(axisCount(9500, 10_000, 500)).toBe('0.95万')
    expect(axisCount(10_000, 10_000, 500)).toBe('1万')
    expect(axisCount(12_000, 13_000, 1000)).toBe('1.2万')
    expect(axisCount(0, 13_000, 1000)).toBe('0')
    expect(axisCount(250_000_000, 3e8, 5e7)).toBe('2.5亿')
  })

  it('dates an axis by the time within a day, else by the day', () => {
    const now = new Date(2026, 10, 24, 12)
    const at = new Date(2026, 10, 3, 9, 5).getTime()
    expect(axisDate(at, 3_600_000, now)).toBe('9:05')
    expect(axisDate(at, 7 * 86_400_000, now)).toBe('11月3日')
    expect(axisDate(new Date(2025, 0, 2).getTime(), 1e10, now)).toBe(
      '2025年1月2日',
    )
  })
})

describe('scales', () => {
  it('fits the readings between round ticks, not from zero', () => {
    expect(valueScale([12_340, 12_410])).toEqual({
      min: 12_300,
      max: 12_450,
      by: 50,
      ticks: [12_300, 12_350, 12_400, 12_450],
    })
  })

  it('puts a count that never moved in the middle, between round ticks', () => {
    expect(valueScale([2901, 2901])).toEqual({
      min: 2401,
      max: 3401,
      by: 500,
      ticks: [2500, 3000],
    })
    const scale = valueScale([550, 550])
    expect(scale.max - 550).toBe(550 - scale.min)
    expect(scale.ticks).toEqual([500, 600])
    expect(valueScale([0, 0])).toMatchObject({ min: 0, ticks: [0, 1] })
    expect(valueScale([1, 2]).ticks.every(Number.isInteger)).toBe(true)
  })

  const trend: Trend = {
    key: 'likes',
    label: '点赞',
    points: [
      { id: 'a', at: 0, value: 10 },
      { id: 'b', at: 1000, value: 20 },
      { id: 'c', at: 4000, value: 15 },
    ],
  }

  it('places readings by their time and value', () => {
    const box = frame(354, 132)
    const shape = geometry(trend, box, new Date(0))
    expect(shape.xs[0]).toBe(box.left)
    expect(shape.xs[2]).toBe(box.right)
    // Uneven gaps between captures stay uneven.
    expect(shape.xs[1]! - shape.xs[0]!).toBeCloseTo(
      (shape.xs[2]! - shape.xs[0]!) / 4,
    )
    expect(shape.ys[1]).toBeLessThan(shape.ys[2]!)
    expect(shape.ys[2]).toBeLessThan(shape.ys[0]!)
    expect(shape.path.startsWith(`M${box.left.toFixed(1)},`)).toBe(true)
    expect(shape.path.split('L')).toHaveLength(3)
    expect(shape.ticks.map((t) => t.label)).toEqual(['10', '15', '20'])
  })

  it('finds the reading nearest a pointer', () => {
    const xs = [0, 10, 40]
    expect(nearest(xs, -5)).toBe(0)
    expect(nearest(xs, 4)).toBe(0)
    expect(nearest(xs, 6)).toBe(1)
    expect(nearest(xs, 26)).toBe(2)
    expect(nearest(xs, 99)).toBe(2)
    expect(nearest([5], 0)).toBe(0)
  })

  it('lists every capture newest first for the table', () => {
    const other: Trend = {
      key: 'replies',
      label: '回复',
      points: [
        { id: 'a', at: 0, value: 1200 },
        { id: 'c', at: 4000, value: 3 },
      ],
    }
    expect(tableRows([trend, other])).toEqual([
      { id: 'c', at: 4000, values: ['15', '3'] },
      { id: 'b', at: 1000, values: ['20', ''] },
      { id: 'a', at: 0, values: ['10', '1,200'] },
    ])
  })
})
