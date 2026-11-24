import { accountName } from './follows'
import {
  avatarURL,
  caption,
  CENTER_SIZE,
  initialOf,
  NODE_SIZE,
  nodeSize,
  type GraphEdgeView,
  type GraphModel,
  type GraphNodeView,
} from './graph'
import { removeOverlaps, type Point } from './graph-layout'
import type { CompareAccount, RelationCompare } from './api'

// Comparing several accounts' relations (关系对比): what the server sends,
// turned into what the page shows. Kept free of sigma, like graph.ts.

export type CompareSide = 'following' | 'followers'

export const SIDES: { value: CompareSide; label: string }[] = [
  { value: 'following', label: '关注' },
  { value: 'followers', label: '粉丝' },
]

/** An exact subset of the compared accounts, as the address writes it. */
export const subsetKey = (of: readonly number[]) => of.join(',')

const SUBSET = /^\d+(?:,\d+)*$/

/** `only` from the address: sorted, distinct indexes below `n`, or none. */
export function parseSubset(raw: string | null | undefined, n: number) {
  if (!raw || !SUBSET.test(raw)) return
  const of = [...new Set(raw.split(',').map(Number))].toSorted((a, b) => a - b)
  return of.every((i) => i < n) ? of : undefined
}

/** Who follows whom among the compared: `follows[a][b]` when a follows b. */
export function followMatrix(data: RelationCompare): boolean[][] {
  const n = data.accounts.length
  const matrix = Array.from({ length: n }, () =>
    Array.from<boolean>({ length: n }).fill(false),
  )
  for (const [a, b] of data.edges) if (a < n && b < n) matrix[a]![b] = true
  return matrix
}

/** A compared account's own view, for avatars and the graph. */
function accountView(
  account: CompareAccount,
  index: number,
  showSensitive: boolean,
): GraphNodeView {
  const node = {
    ...account,
    entity_id: account.entity_id ?? `missing:${index}`,
  }
  return view(node, true, CENTER_SIZE, showSensitive)
}

function view(
  node: GraphNodeView['node'],
  center: boolean,
  size: number,
  showSensitive: boolean,
  extra: Partial<GraphNodeView> = {},
): GraphNodeView {
  const image = node.avatar ? avatarURL(node.avatar) : ''
  const label = accountName(node)
  return {
    key: node.entity_id,
    node,
    center,
    size,
    ...(image && (showSensitive || !node.avatar?.sensitive) ? { image } : {}),
    ...(node.viewer ? { viewer: node.viewer } : {}),
    initial: initialOf(node),
    label,
    caption: caption(label),
    ...extra,
  }
}

/** The compared accounts as the page draws their avatars. */
export function accountViews(
  data: RelationCompare | undefined,
  showSensitive = false,
): GraphNodeView[] {
  return (data?.accounts ?? []).map((account, i) =>
    accountView(account, i, showSensitive),
  )
}

/** The accounts found, each with the compared ones it relates to. */
export function itemViews(
  data: RelationCompare | undefined,
  side: CompareSide,
  showSensitive = false,
): (GraphNodeView & { of: number[] })[] {
  return (data?.items ?? []).map((item) => ({
    ...view(item, false, nodeSize(item.followers), showSensitive, {
      kind: item.of.length > 1 ? 'shared' : side,
    }),
    of: item.of,
  }))
}

/**
 * The comparison graph: the compared accounts spread apart, each account
 * found placed among the ones it relates to, its follows with them shown
 * when in focus, and the follows among all of them.
 */
export function compareModel(
  data: RelationCompare | undefined,
  side: CompareSide,
  showSensitive = false,
): GraphModel {
  if (!data) return { nodes: [], edges: [] }
  const centers = accountViews(data, showSensitive)
  const items = itemViews(data, side, showSensitive)
  const nodes = [...centers, ...items]
  const n = centers.length
  const directed = new Set(data.edges.map(([a, b]) => `${a}>${b}`))
  const edges: GraphEdgeView[] = []
  for (const [a, b] of data.edges) {
    const back = directed.has(`${b}>${a}`)
    if (back && a > b) continue
    // A follow between a compared account and one found only says why it
    // was found: shown in focus, like a profile graph's own.
    const own = a < n !== b < n
    edges.push({
      key: `${a}>${b}`,
      source: nodes[a]!.key,
      target: nodes[b]!.key,
      mutual: back,
      kind: own ? side : 'peer',
    })
  }
  return {
    nodes,
    edges,
    positions: compareLayout(
      centers.map((c) => ({ key: c.key, size: c.size })),
      items.map((item) => ({ key: item.key, size: item.size, of: item.of })),
    ),
  }
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * Where everyone goes in the comparison graph. The compared accounts sit
 * on a circle (two side by side), far enough apart for what lies between.
 * Each subset's accounts gather in a sunflower spiral at the centroid of
 * the compared accounts they relate to; an account related to one only is
 * placed outside its own, away from the middle. Overlaps are then pushed
 * apart, the compared accounts held still.
 */
export function compareLayout(
  centers: readonly { key: string; size: number }[],
  items: readonly { key: string; size: number; of: readonly number[] }[],
): Map<string, Point> {
  const n = centers.length
  const step = NODE_SIZE * 2.5
  const spacing = step * 0.62
  const radius =
    n < 2
      ? 0
      : step * (1.8 + 0.36 * Math.sqrt(items.length)) * (n > 2 ? 1 : 0.8)
  const anchors = centers.map((_center, i): Point => {
    if (n < 2) return { x: 0, y: 0 }
    // Clockwise from the left for two, from the top for more.
    const angle = n === 2 ? Math.PI * i : Math.PI / 2 - (2 * Math.PI * i) / n
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const key = subsetKey(item.of)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const points: Point[] = anchors.map((p) => ({ ...p }))
  const sizes = centers.map((c) => c.size)
  const fixed = centers.map(() => true)
  const keys = centers.map((c) => c.key)
  for (const group of groups.values()) {
    const of = group[0]!.of
    if (!of.length || of.some((i) => !anchors[i])) continue
    let at: Point = {
      x: of.reduce((sum, i) => sum + anchors[i]!.x, 0) / of.length,
      y: of.reduce((sum, i) => sum + anchors[i]!.y, 0) / of.length,
    }
    // A spiral starts on the center itself when there is one there.
    let skip = 0
    if (of.length === 1) {
      const own = anchors[of[0]!]!
      const out = Math.hypot(own.x, own.y)
      if (out > 0) {
        const reach = spacing * Math.sqrt(group.length) + CENTER_SIZE + step
        at = {
          x: own.x + (own.x / out) * reach * 0.6,
          y: own.y + (own.y / out) * reach * 0.6,
        }
      }
      skip = 3
    }
    group.forEach((item, j) => {
      const r = spacing * Math.sqrt(j + skip + 0.5)
      const angle = (j + skip) * GOLDEN
      points.push({
        x: at.x + Math.cos(angle) * r,
        y: at.y + Math.sin(angle) * r,
      })
      sizes.push(item.size)
      fixed.push(false)
      keys.push(item.key)
    })
  }
  removeOverlaps(points, sizes, fixed, 200)
  return new Map(keys.map((key, i) => [key, points[i]!]))
}

/** The rows of the combination table, with each one's share of the largest. */
export function comboRows(data: RelationCompare | undefined) {
  const combos = data?.combos ?? []
  const most = Math.max(1, ...combos.map((combo) => combo.count))
  return combos.map((combo) => ({
    ...combo,
    key: subsetKey(combo.of),
    share: combo.count / most,
  }))
}
