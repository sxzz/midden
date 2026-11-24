import { expect, it } from 'vitest'
import {
  comboRows,
  compareLayout,
  compareModel,
  followMatrix,
  parseSubset,
} from './compare'
import type { RelationCompare } from './api'

const data = (): RelationCompare => ({
  accounts: [
    {
      key: 'x/x.profile/1',
      external_id: '1',
      entity_id: 'a',
      name: '甲',
      lists: { following: {}, followers: {} },
    },
    {
      key: 'x/x.profile/2',
      external_id: '2',
      entity_id: 'b',
      name: '乙',
      lists: { following: {}, followers: {} },
    },
  ],
  items: [
    {
      entity_id: 's',
      key: 'x/x.profile/3',
      external_id: '3',
      name: '共同',
      of: [0, 1],
      viewer: 'mutual',
    },
    {
      entity_id: 'o',
      key: 'x/x.profile/4',
      external_id: '4',
      name: '只甲',
      of: [0],
    },
  ],
  total: 2,
  // 甲 follows 乙 and both found; the found follow each other.
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [2, 3],
    [3, 2],
  ],
  combos: [
    { of: [0, 1], count: 1 },
    { of: [0], count: 1 },
  ],
})

it('reads who follows whom among the compared', () => {
  expect(followMatrix(data())).toEqual([
    [false, true],
    [false, false],
  ])
})

it('takes a subset from the address only when it fits', () => {
  expect(parseSubset('1,0,1', 2)).toEqual([0, 1])
  expect(parseSubset('2', 2)).toBeUndefined()
  expect(parseSubset('a', 2)).toBeUndefined()
  expect(parseSubset('', 2)).toBeUndefined()
})

it('sizes the combination rows by the largest', () => {
  const rows = comboRows({
    ...data(),
    combos: [
      { of: [0, 1], count: 8 },
      { of: [1], count: 2 },
    ],
  })
  expect(rows.map((row) => [row.key, row.share])).toEqual([
    ['0,1', 1],
    ['1', 0.25],
  ])
})

it('draws the compared as centers and the found by how many they share', () => {
  const model = compareModel(data(), 'following')
  expect(
    model.nodes.map((node) => [node.label, node.center, node.kind ?? '']),
  ).toEqual([
    ['甲', true, ''],
    ['乙', true, ''],
    ['共同', false, 'shared'],
    ['只甲', false, 'following'],
  ])
  expect(model.nodes[2]!.viewer).toBe('mutual')
  // A follow among the compared, or among the found, is always drawn; one
  // between them says why an account was found, shown in focus.
  expect(model.edges.map((edge) => [edge.key, edge.kind, edge.mutual])).toEqual(
    [
      ['0>1', 'peer', false],
      ['0>2', 'following', false],
      ['0>3', 'following', false],
      ['1>2', 'following', false],
      ['2>3', 'peer', true],
    ],
  )
  expect(model.positions?.size).toBe(4)
})

it('places shared accounts between their centers, the rest outside their own', () => {
  const centers = [
    { key: 'a', size: 30 },
    { key: 'b', size: 30 },
    { key: 'c', size: 30 },
  ]
  const items = [
    ...Array.from({ length: 12 }, (_, i) => ({
      key: `ab${i}`,
      size: 20,
      of: [0, 1],
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      key: `c${i}`,
      size: 20,
      of: [2],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      key: `all${i}`,
      size: 20,
      of: [0, 1, 2],
    })),
  ]
  const at = compareLayout(centers, items)
  const mean = (prefix: string) => {
    const points = [...at].filter(([key]) => key.startsWith(prefix))
    return {
      x: points.reduce((sum, [, p]) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, [, p]) => sum + p.y, 0) / points.length,
    }
  }
  const [a, b, c] = ['a', 'b', 'c'].map((key) => at.get(key)!)
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y)
  // The centers are far apart.
  expect(dist(a!, b!)).toBeGreaterThan(150)
  // Shared by 甲 and 乙: nearer the middle of the two than either of them.
  const ab = mean('ab')
  const middle = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }
  expect(dist(ab, middle)).toBeLessThan(dist(ab, a!))
  // Only 丙's: beyond 丙, away from the middle.
  expect(Math.hypot(mean('c').x, mean('c').y)).toBeGreaterThan(
    Math.hypot(c!.x, c!.y),
  )
  // All three: about the middle.
  expect(Math.hypot(mean('all').x, mean('all').y)).toBeLessThan(
    dist(a!, b!) / 3,
  )
  // No two avatars overlap.
  const placed = [...at]
  const size = (key: string) => (key.length === 1 ? 30 : 20)
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const [ki, pi] = placed[i]!
      const [kj, pj] = placed[j]!
      expect(dist(pi, pj)).toBeGreaterThanOrEqual(size(ki) + size(kj) - 0.5)
    }
})
