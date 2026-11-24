import { expect, it } from 'vitest'
import {
  byFollowers,
  removeOverlaps,
  ringLayout,
  settle,
  type LayoutNode,
  type Point,
} from './graph-layout'

/** A center and accounts of each kind, sizes and follower counts varied. */
function nodes(counts: {
  mutual: number
  following: number
  followers: number
}) {
  const list: LayoutNode[] = [{ key: 'c', size: 30, center: true }]
  let i = 0
  for (const kind of ['mutual', 'following', 'followers'] as const)
    for (let n = 0; n < counts[kind]; n++, i++)
      list.push({
        key: `${kind}-${n}`,
        kind,
        size: 17 + ((i * 13) % 7),
        ...(n % 11 === 5 ? {} : { followers: (i * 7919) % 100_000 }),
      })
  return list
}

const distance = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y)
/** How far out a place is, as the bands measure it (a rounded square at aspect 1). */
const band = (p: Point) => Math.cbrt(Math.abs(p.x) ** 3 + Math.abs(p.y) ** 3)

/** Every pair of avatars apart, none at the same place. */
function expectApart(list: LayoutNode[], at: Map<string, Point>) {
  expect(at.size).toBe(list.length)
  const seen = new Set<string>()
  for (const p of at.values()) {
    const key = `${p.x},${p.y}`
    expect(seen.has(key)).toBe(false)
    seen.add(key)
  }
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!
      const b = list[j]!
      expect(distance(at.get(a.key)!, at.get(b.key)!)).toBeGreaterThanOrEqual(
        a.size + b.size,
      )
    }
}

it('puts the center in the middle and every account apart, at distinct places', () => {
  const list = nodes({ mutual: 132, following: 77, followers: 91 })
  const at = ringLayout(list, 2)
  expect(at.get('c')).toEqual({ x: 0, y: 0 })
  expectApart(list, at)
})

it('places 互关 innermost, then 关注, then 粉丝', () => {
  const list = nodes({ mutual: 60, following: 40, followers: 80 })
  const at = ringLayout(list, 1)
  const reach = (kind: string) =>
    list.filter((n) => n.kind === kind).map((n) => band(at.get(n.key)!))
  const max = (xs: number[]) => Math.max(...xs)
  const min = (xs: number[]) => Math.min(...xs)
  expect(max(reach('mutual'))).toBeLessThanOrEqual(min(reach('following')))
  expect(max(reach('following'))).toBeLessThanOrEqual(min(reach('followers')))
})

it('starts each band with its most followed, at the top', () => {
  const list = nodes({ mutual: 40, following: 0, followers: 0 })
  const at = ringLayout(list, 1)
  const [top] = byFollowers(list.filter((n) => !n.center))
  const first = at.get(top!.key)!
  // Graph y points up: the most followed is above the center, near the axis.
  expect(first.y).toBeGreaterThan(0)
  expect(Math.abs(first.x)).toBeLessThanOrEqual(first.y)
  // And in the innermost row.
  const radii = list
    .filter((n) => !n.center)
    .map((n) => Math.hypot(at.get(n.key)!.x, at.get(n.key)!.y))
  expect(Math.hypot(first.x, first.y)).toBeLessThan(Math.min(...radii) * 1.5)
})

it('takes the canvas’s shape: wide on a desktop, tall on a phone', () => {
  const list = nodes({ mutual: 130, following: 80, followers: 90 })
  const extent = (aspect: number) => {
    const points = [...ringLayout(list, aspect).values()]
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    return (
      (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))
    )
  }
  expect(extent(2.1)).toBeGreaterThan(1.6)
  expect(extent(390 / 640)).toBeLessThan(0.8)
})

it('keeps places distinct when more accounts are shown', () => {
  // 「显示更多」: the same accounts and more, placed afresh.
  const first = nodes({ mutual: 100, following: 100, followers: 100 })
  const more = nodes({ mutual: 200, following: 200, followers: 200 })
  expectApart(first, ringLayout(first, 1.6))
  const at = ringLayout(more, 1.6)
  expect(at.size).toBe(more.length)
  expect(new Set([...at.values()].map((p) => `${p.x},${p.y}`)).size).toBe(
    more.length,
  )
})

it('lays out a center alone, or nothing', () => {
  expect(ringLayout([], 1).size).toBe(0)
  expect([...ringLayout([{ key: 'c', size: 30, center: true }], 1)]).toEqual([
    ['c', { x: 0, y: 0 }],
  ])
})

it('settles a force layout: no overlaps, none at one place, the center fixed', () => {
  // A force layout leaves some piled up, some far apart.
  const points: Point[] = [{ x: 0, y: 0 }]
  for (let i = 0; i < 60; i++)
    points.push(
      i < 20
        ? { x: 500, y: 500 }
        : { x: 2000 * Math.cos(i), y: 2000 * Math.sin(i) },
    )
  const sizes = points.map((_, i) => (i ? 20 : 30))
  const fixed = points.map((_, i) => i === 0)
  settle(points, sizes, fixed, 1.5)
  expect(points[0]).toEqual({ x: 0, y: 0 })
  expect(removeOverlaps(points, sizes, fixed, 1)).toBe(0)
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      expect(distance(points[i]!, points[j]!)).toBeGreaterThanOrEqual(
        sizes[i]! + sizes[j]!,
      )
})
