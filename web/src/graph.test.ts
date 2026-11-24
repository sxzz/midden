import { expect, it } from 'vitest'
import {
  avatarURL,
  caption,
  edgeLook,
  focusOf,
  graphGroups,
  graphModel,
  initialOf,
  layoutKind,
  listsText,
  nodeOpacity,
  nodeSize,
  peerShare,
  shortDay,
  type GraphKind,
} from './graph'
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

it('keeps each node’s key, name and edges its own when more are shown', () => {
  // 「显示更多」: the server sends the same accounts first, then more, and
  // edge indexes into the longer list.
  const people = Array.from({ length: 8 }, (_, i) => ({
    entity_id: `e${i}`,
    external_id: String(i),
    name: ['小智', '小云', '天末', 'Steven', '甲', '乙', '丙', '丁'][i],
    kind: 'mutual' as const,
  }))
  const shown = (count: number): FollowGraph => ({
    nodes: [{ entity_id: 'c', external_id: 'c' }, ...people.slice(0, count)],
    edges: [
      [1, 3],
      [count, 1],
    ],
    total: 8,
    kinds: { following: 0, followers: 0, mutual: 8 },
    lists: { following: {}, followers: {} },
  })
  for (const count of [4, 8]) {
    const sent = shown(count)
    const m = graphModel(sent)
    for (const view of m.nodes) {
      const own = sent.nodes.find((n) => n.entity_id === view.key)!
      expect(view.node).toBe(own)
      expect(view.label).toBe(own.name ?? 'ID c')
    }
    const byKey = new Map(m.nodes.map((v) => [v.key, v.label]))
    expect(
      m.edges.map((e) => `${byKey.get(e.source)}>${byKey.get(e.target)}`),
    ).toEqual(['小智>天末', `${people[count - 1]!.name}>小智`])
  }
})

it('maps nothing to nothing', () => {
  expect(graphModel(undefined)).toEqual({ nodes: [], edges: [] })
})

it('sizes by follower count on a log scale, mildly', () => {
  expect(nodeSize(undefined)).toBe(nodeSize(0))
  expect(nodeSize(1000)).toBeGreaterThan(nodeSize(10))
  // Never more than about a third apart.
  expect(nodeSize(1e12) / nodeSize(0)).toBeLessThan(1.4)
  expect(nodeSize(1e12)).toBe(nodeSize(1e9))
})

it('cuts names to about an avatar’s width, a CJK character counting two', () => {
  expect(caption('Steven')).toBe('Steven')
  expect(caption('天末')).toBe('天末')
  expect(caption('一二三四五六七八')).toBe('一二三四五六七…')
  expect(caption('abcdefghijklmnopq')).toBe('abcdefghijklmn…')
})

it('asks X for a larger avatar than its 48px one, only when never saved', () => {
  const remote = (url: string) =>
    asset({ id: 'r', purpose: 'avatar', remote_url: url })
  expect(
    avatarURL(remote('https://pbs.twimg.com/profile_images/1/abc_normal.jpg')),
  ).toBe('https://pbs.twimg.com/profile_images/1/abc_200x200.jpg')
  expect(avatarURL(remote('https://m.test/a_normal.jpg'))).toBe(
    'https://m.test/a_normal.jpg',
  )
  expect(
    avatarURL(
      asset({
        id: 's',
        purpose: 'avatar',
        thumbnail_url: '/media/s-small',
        remote_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg',
      }),
    ),
  ).toBe('/media/s-small')
})

/** A center with mutuals, followings and followers, and follows among some of them. */
function model(counts: Record<GraphKind, number>, peers: [number, number][]) {
  const kinds = (['mutual', 'following', 'followers'] as const).flatMap(
    (kind) => Array.from<GraphKind>({ length: counts[kind] }).fill(kind),
  )
  const nodes = [
    { entity_id: 'c', external_id: '0' },
    ...kinds.map((kind, i) => ({
      entity_id: `n${i + 1}`,
      external_id: String(i + 1),
      followers: (i * 7919) % 1000,
      kind,
    })),
  ]
  return graphModel({
    nodes,
    edges: [
      ...kinds.map((kind, i): [number, number] =>
        kind === 'followers' ? [i + 1, 0] : [0, i + 1],
      ),
      ...peers,
    ],
    total: kinds.length,
    kinds: counts,
    lists: { following: {}, followers: {} },
  })
}

it('draws rings when follows among the others are few, a force layout once they shape circles', () => {
  // Only the center's lists known: a star.
  const star = model({ mutual: 130, following: 80, followers: 90 }, [])
  expect(peerShare(star)).toBe(0)
  expect(layoutKind(star)).toBe('rings')
  // A few accounts linked: still rings (3 of 300 is 1%).
  const few = model({ mutual: 130, following: 80, followers: 90 }, [
    [1, 2],
    [2, 3],
  ])
  expect(layoutKind(few)).toBe('rings')
  // Two circles of 20 among 100 accounts: 40%.
  const circles: [number, number][] = []
  for (let i = 1; i < 20; i++) circles.push([i, i + 1], [i + 40, i + 41])
  const clustered = model({ mutual: 50, following: 30, followers: 20 }, circles)
  expect(peerShare(clustered)).toBeCloseTo(0.4)
  expect(layoutKind(clustered)).toBe('force')
  // A tiny graph needs at least three linked accounts.
  expect(
    layoutKind(model({ mutual: 4, following: 0, followers: 0 }, [[1, 2]])),
  ).toBe('rings')
})

it('groups the list by kind, innermost first, most followed first', () => {
  const groups = graphGroups(graphModel(graph))
  expect(groups.map((g) => [g.kind, g.nodes.map((n) => n.key)])).toEqual([
    ['mutual', ['m']],
    ['following', ['g']],
    ['followers', ['f']],
  ])
  const many = graphGroups(model({ mutual: 5, following: 0, followers: 3 }, []))
  expect(many.map((g) => g.kind)).toEqual(['mutual', 'followers'])
  for (const group of many) {
    const counts = group.nodes.map((n) => n.node.followers!)
    expect(counts).toEqual(counts.toSorted((a, b) => b - a))
  }
})

it('focuses an account: itself, its neighbours and its edges', () => {
  const m = graphModel(graph)
  const focus = focusOf(m, 'f')!
  expect([...focus.nodes].toSorted()).toEqual(['c', 'f', 'g', 'm'])
  expect([...focus.edges].toSorted()).toEqual(['1>2', '2>0', '2>3'])
  expect(focusOf(m, 'nobody')).toBeUndefined()
  expect(focusOf(m, undefined)).toBeUndefined()
})

it('hides the center’s edges unless focused, draws the others’ clearly, dims the rest in focus', () => {
  const calm = { highlighted: false, focusing: false }
  expect(edgeLook('mutual', calm).visible).toBe(false)
  expect(edgeLook('followers', calm).visible).toBe(false)
  expect(edgeLook('peer', calm)).toMatchObject({ visible: true })
  expect(edgeLook('peer', calm).opacity).toBeGreaterThanOrEqual(0.5)
  // In focus: its edges stand out, whatever their kind; others fade.
  const lit = edgeLook('following', { highlighted: true, focusing: true })
  expect(lit.visible).toBe(true)
  expect(lit.opacity).toBeGreaterThan(0.9)
  expect(
    edgeLook('peer', { highlighted: false, focusing: true }).opacity,
  ).toBeLessThan(0.2)
  expect(
    edgeLook('mutual', { highlighted: false, focusing: true }).visible,
  ).toBe(false)
  expect(nodeOpacity(calm)).toBe(1)
  expect(nodeOpacity({ highlighted: true, focusing: true })).toBe(1)
  expect(nodeOpacity({ highlighted: false, focusing: true })).toBeLessThan(0.5)
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
