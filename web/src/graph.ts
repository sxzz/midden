import { previewURL, type FollowGraph, type GraphNode } from './api'
import { accountName } from './follows'

// The follow graph (关系图谱) as the page draws it: what the server sends,
// turned into nodes and edges with their looks. Kept free of sigma so it
// tests without WebGL and loads with the page, not the renderer.

export type GraphKind = NonNullable<GraphNode['kind']>

export const graphKinds: readonly GraphKind[] = [
  'following',
  'followers',
  'mutual',
]

/** Each account has one: only followed, only following, or both. */
export const kindLabels: Record<GraphKind, string> = {
  following: '关注',
  followers: '粉丝',
  mutual: '互关',
}

/** How many accounts the page asks for at first, and more each time. */
export const GRAPH_PAGE = 300

export interface GraphNodeView {
  key: string
  node: GraphNode
  center: boolean
  kind?: GraphKind
  /** Bigger with more followers, the center biggest. */
  size: number
  /** The avatar to draw, if any; else `initial` stands for it. */
  image?: string
  initial: string
  label: string
}

/**
 * A follow between two shown accounts: one-way from `source` to `target`,
 * or both ways (`mutual`, drawn without an arrow). `kind` is the other
 * account's for the center's own; `peer` for one between two others,
 * drawn lighter.
 */
export interface GraphEdgeView {
  key: string
  source: string
  target: string
  mutual: boolean
  kind: GraphKind | 'peer'
}

export interface GraphModel {
  nodes: GraphNodeView[]
  edges: GraphEdgeView[]
}

/** The first character of the name shown, for an account without avatar. */
export function initialOf(node: GraphNode): string {
  const text = node.name || node.username || ''
  const first = Array.from(text.trim())[0]
  return first ? first.toUpperCase() : '?'
}

/** A node's size by its follower count, on a log scale. */
export function nodeSize(followers?: number): number {
  const count = Math.max(0, followers ?? 0)
  return Math.min(15, 5 + 1.5 * Math.log10(1 + count))
}

const CENTER_SIZE = 18

export function graphModel(
  graph: FollowGraph | undefined,
  options: { showSensitive?: boolean } = {},
): GraphModel {
  if (!graph?.nodes.length) return { nodes: [], edges: [] }
  const nodes = graph.nodes.map((node, index): GraphNodeView => {
    const image = node.avatar ? previewURL(node.avatar) : ''
    return {
      key: node.entity_id,
      node,
      center: index === 0,
      ...(node.kind ? { kind: node.kind } : {}),
      size: index === 0 ? CENTER_SIZE : nodeSize(node.followers),
      // A sensitive avatar stays covered by the initial unless all are shown.
      ...(image && (options.showSensitive || !node.avatar?.sensitive)
        ? { image }
        : {}),
      initial: initialOf(node),
      label: accountName(node),
    }
  })
  // One edge per pair: both directions make it mutual.
  const directed = new Set(graph.edges.map(([a, b]) => `${a}>${b}`))
  const edges: GraphEdgeView[] = []
  for (const [a, b] of graph.edges) {
    const back = directed.has(`${b}>${a}`)
    // A mutual pair is drawn once, from the lower index.
    if (back && a > b) continue
    const other = a === 0 ? b : b === 0 ? a : undefined
    edges.push({
      key: `${a}>${b}`,
      source: nodes[a]!.key,
      target: nodes[b]!.key,
      mutual: back,
      kind: other === undefined ? 'peer' : nodes[other]!.kind!,
    })
  }
  return { nodes, edges }
}

/** A day as the completeness line names it, e.g. 11-20, with the year if not this one. */
export function shortDay(value: string, now = new Date()): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const day = `${d.getMonth() + 1}-${d.getDate()}`
  return d.getFullYear() === now.getFullYear()
    ? day
    : `${d.getFullYear()}-${day}`
}

const listNames = { following: '关注名单', followers: '粉丝名单' } as const

/**
 * How complete the lists behind the graph are, in one line, e.g.
 * 关注名单 11-20 完整抓取 · 粉丝名单未抓取.
 */
export function listsText(
  lists: FollowGraph['lists'] | undefined,
  now = new Date(),
): string {
  if (!lists) return ''
  return (['following', 'followers'] as const)
    .map((list) => {
      const { complete_at, partial_at } = lists[list]
      const name = listNames[list]
      if (complete_at) return `${name} ${shortDay(complete_at, now)} 完整抓取`
      if (partial_at) return `${name} ${shortDay(partial_at, now)} 部分抓取`
      return `${name}未抓取`
    })
    .join(' · ')
}
