import { expect, it } from 'vitest'
import { graphModel, initialOf, listsText, nodeSize, shortDay } from './graph'
import { asset } from './testing/api'
import type { FollowGraph } from './api'

const graph: FollowGraph = {
  nodes: [
    {
      entity_id: 'c',
      external_id: '100',
      name: 'Center',
      followers: 10,
      collection_id: 'cc',
    },
    {
      entity_id: 'm',
      external_id: '1',
      name: '小林',
      username: 'kobayashi',
      followers: 5000,
      kind: 'mutual',
      avatar: asset({
        id: 'a',
        purpose: 'avatar',
        remote_url: 'https://x/a.jpg',
      }),
    },
    {
      entity_id: 'f',
      external_id: '2',
      username: 'fan',
      kind: 'followers',
      avatar: asset({
        id: 'b',
        purpose: 'avatar',
        url: '/media/b',
        thumbnail_url: '/media/b-small',
        sensitive: true,
      }),
    },
    { entity_id: 'g', external_id: '3', kind: 'following' },
  ],
  // c<->m, f->c, c->g, and between others: m->f and f<->g.
  edges: [
    [0, 1],
    [1, 0],
    [2, 0],
    [0, 3],
    [1, 2],
    [2, 3],
    [3, 2],
  ],
  total: 3,
  kinds: { following: 1, followers: 1, mutual: 1 },
  lists: { following: {}, followers: {} },
}

it('maps nodes: the center first and biggest, avatars or initials', () => {
  const { nodes } = graphModel(graph)
  expect(nodes.map((n) => [n.key, n.center, n.kind, n.label])).toEqual([
    ['c', true, undefined, 'Center'],
    ['m', false, 'mutual', '小林'],
    ['f', false, 'followers', '@fan'],
    ['g', false, 'following', 'ID 3'],
  ])
  expect(nodes[0]!.size).toBeGreaterThan(nodes[1]!.size)
  expect(nodes[1]!.size).toBeGreaterThan(nodes[3]!.size)
  // From the platform when never saved here.
  expect(nodes[1]!.image).toBe('https://x/a.jpg')
  // A sensitive avatar is left to its initial unless all are shown.
  expect(nodes[2]!.image).toBeUndefined()
  expect(graphModel(graph, { showSensitive: true }).nodes[2]!.image).toBe(
    '/media/b-small',
  )
  expect(nodes.map((n) => n.initial)).toEqual(['C', '小', 'F', '?'])
})

it('maps edges: one per pair, mutual without direction, peers apart', () => {
  const { edges } = graphModel(graph)
  expect(edges.map((e) => [e.source, e.target, e.mutual, e.kind])).toEqual([
    ['c', 'm', true, 'mutual'],
    ['f', 'c', false, 'followers'],
    ['c', 'g', false, 'following'],
    ['m', 'f', false, 'peer'],
    ['f', 'g', true, 'peer'],
  ])
})

it('maps nothing to nothing', () => {
  expect(graphModel(undefined)).toEqual({ nodes: [], edges: [] })
})

it('sizes by follower count on a log scale, within bounds', () => {
  expect(nodeSize(undefined)).toBe(nodeSize(0))
  expect(nodeSize(1000)).toBeGreaterThan(nodeSize(10))
  expect(nodeSize(1e12)).toBe(15)
})

it('takes the first character for an initial', () => {
  expect(initialOf({ entity_id: 'x', external_id: '1', name: ' émile' })).toBe(
    'É',
  )
  expect(initialOf({ entity_id: 'x', external_id: '1', name: '😀 hi' })).toBe(
    '😀',
  )
})

it('says how complete each list is in one line', () => {
  const now = new Date(2026, 10, 24)
  expect(
    listsText(
      {
        following: { complete_at: new Date(2026, 10, 20, 8).toISOString() },
        followers: {},
      },
      now,
    ),
  ).toBe('关注名单 11-20 完整抓取 · 粉丝名单未抓取')
  expect(
    listsText(
      {
        following: {},
        followers: { partial_at: new Date(2025, 0, 3).toISOString() },
      },
      now,
    ),
  ).toBe('关注名单未抓取 · 粉丝名单 2025-1-3 部分抓取')
  expect(shortDay('nonsense', now)).toBe('')
})
