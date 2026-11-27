import { previewURL, type FollowGraph, type GraphNode } from './api'
import { accountName } from './follows'
import { byFollowers, ringOrder, type Point } from './graph-layout'
import { profileURL } from './presentation'

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

/** How the chosen viewer account relates to a node. */
export type ViewerRelation = NonNullable<GraphNode['viewer']>

export interface GraphNodeView {
  key: string
  node: GraphNode
  center: boolean
  /** A comparison's account shared by several compared ones is `shared`. */
  kind?: GraphKind | 'shared'
  /** The viewer's relation to it, when a viewer is chosen and has one. */
  viewer?: ViewerRelation
  /** Radius in layout units: the center biggest, others a little by followers. */
  size: number
  /** The avatar to draw, if any; else `initial` stands for it. */
  image?: string
  initial: string
  /** The name in the card and the list. */
  label: string
  /** Its language, when the label is the account's own name. */
  lang?: string
  /** The name under the avatar, cut to about an avatar's width. */
  caption: string
}

/**
 * A follow between two shown accounts: one-way from `source` to `target`,
 * or both ways (`mutual`, drawn without an arrow). `kind` is the other
 * account's for the center's own; `peer` for one between two others.
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
  /** Places worked out beforehand (a comparison's), instead of a layout. */
  positions?: Map<string, Point>
}

/** The first character of the name shown, for an account without avatar. */
export function initialOf(node: GraphNode): string {
  const text = node.name || node.username || ''
  const first = Array.from(text.trim())[0]
  return first ? first.toUpperCase() : '?'
}

/** The radius of an account's avatar, in layout units. */
export const NODE_SIZE = 20
export const CENTER_SIZE = 30

/**
 * A node's size by its follower count, on a log scale but mildly: from
 * 0.85 to 1.15 of the usual size, so no avatar is much smaller than another.
 */
export function nodeSize(followers?: number): number {
  const count = Math.max(0, followers ?? 0)
  return NODE_SIZE * (0.85 + 0.3 * Math.min(1, Math.log10(1 + count) / 7))
}

/** About an avatar's width of text, a wide (CJK) character counting two. */
const CAPTION_WIDTH = 14

export function caption(label: string, width = CAPTION_WIDTH): string {
  let used = 0
  let out = ''
  for (const char of label) {
    const wide = char.length > 1 || char.charCodeAt(0) >= 0x2e80
    used += wide ? 2 : 1
    if (used > width) return `${out.trimEnd()}…`
    out += char
  }
  return out
}

/**
 * X's own avatar addresses name a 48px image; the graph draws avatars
 * larger, so it asks X for the 200px one.
 */
export function avatarURL(asset: NonNullable<GraphNode['avatar']>): string {
  const url = previewURL(asset)
  if (url !== asset.remote_url) return url
  return url.replace(normalAvatar, '$1_200x200$2')
}
const normalAvatar =
  /^(https:\/\/pbs\.twimg\.com\/profile_images\/.+)_normal(\.\w+)$/

export function graphModel(
  graph: FollowGraph | undefined,
  options: { showSensitive?: boolean } = {},
): GraphModel {
  if (!graph?.nodes.length) return { nodes: [], edges: [] }
  const nodes = graph.nodes.map((node, index): GraphNodeView => {
    const image = node.avatar ? avatarURL(node.avatar) : ''
    const label = accountName(node)
    return {
      key: node.entity_id,
      node,
      center: index === 0,
      ...(node.kind ? { kind: node.kind } : {}),
      ...(node.viewer ? { viewer: node.viewer } : {}),
      size: index === 0 ? CENTER_SIZE : nodeSize(node.followers),
      // A sensitive avatar stays covered by the initial unless all are shown.
      ...(image && (options.showSensitive || !node.avatar?.sensitive)
        ? { image }
        : {}),
      initial: initialOf(node),
      label,
      ...(node.name && node.lang ? { lang: node.lang } : {}),
      caption: caption(label),
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
      kind: other === undefined ? 'peer' : (nodes[other]!.kind as GraphKind),
    })
  }
  return { nodes, edges }
}

/** From this share of accounts with a follow among the others, force layout. */
export const PEER_SHARE = 0.1

/** Accounts with a follow among the others (not only with the center). */
export function linkedAccounts(model: GraphModel): Set<string> {
  const linked = new Set<string>()
  for (const edge of model.edges)
    if (edge.kind === 'peer') linked.add(edge.source).add(edge.target)
  return linked
}

/** The share of accounts besides the center with a follow among the others. */
export function peerShare(model: GraphModel): number {
  const others = model.nodes.length - 1
  return others < 1 ? 0 : linkedAccounts(model).size / others
}

/**
 * How to place the accounts. Usually only the center's own lists are
 * known, so every follow is with the center and a force layout draws a
 * star: rings by kind show the same compactly. Once enough follows among
 * the others are known, the force layout groups their circles in the
 * middle, and the accounts without such follows keep their rings around.
 */
export function layoutKind(model: GraphModel): 'rings' | 'force' {
  const linked = peerShare(model) * (model.nodes.length - 1)
  return peerShare(model) >= PEER_SHARE && linked >= 3 ? 'force' : 'rings'
}

/** The list's sections, in the rings' order from the inside out. */
export const groupOrder: readonly GraphKind[] = ringOrder

/** The accounts besides the center, by kind, most followed first. */
export function graphGroups(model: GraphModel) {
  return groupOrder
    .map((kind) => ({
      kind,
      nodes: byFollowers(
        model.nodes
          .filter((view) => !view.center && view.kind === kind)
          .map((view) => ({ view, followers: view.node.followers })),
      ).map(({ view }) => view),
    }))
    .filter((group) => group.nodes.length)
}

/** What a hovered or tapped account brings forward. */
export interface Focus {
  /** The account and its neighbours. */
  nodes: Set<string>
  /** Its edges. */
  edges: Set<string>
}

export function focusOf(
  model: GraphModel,
  key: string | undefined,
): Focus | undefined {
  if (!key || model.nodes.every((view) => view.key !== key)) return
  const nodes = new Set([key])
  const edges = new Set<string>()
  for (const edge of model.edges) {
    if (edge.source !== key && edge.target !== key) continue
    edges.add(edge.key)
    nodes.add(edge.source).add(edge.target)
  }
  return { nodes, edges }
}

/** How an edge is drawn: whether it is in the focus, and whether any is. */
export function edgeLook(
  kind: GraphEdgeView['kind'],
  state: { highlighted: boolean; focusing: boolean },
): { visible: boolean; opacity: number; size: number } {
  if (state.highlighted) return { visible: true, opacity: 0.95, size: 2 }
  // A follow with the center says no more than the ring's colour: shown
  // only for the account in focus.
  if (kind !== 'peer') return { visible: false, opacity: 0, size: 0 }
  return state.focusing
    ? { visible: true, opacity: 0.08, size: 1 }
    : { visible: true, opacity: 0.6, size: 1.4 }
}

/** Accounts outside the focus fade back. */
export const nodeOpacity = (state: {
  highlighted: boolean
  focusing: boolean
}) => (state.focusing && !state.highlighted ? 0.22 : 1)

/**
 * The card's line on how the viewer relates to an account, by the viewer's
 * name: 「与 @foo 互关」, 「@foo 关注了 TA」, 「TA 关注了 @foo」.
 */
export function viewerLine(relation: ViewerRelation, name: string): string {
  if (relation === 'mutual') return `与 ${name} 互关`
  if (relation === 'following') return `${name} 关注了 TA`
  return `TA 关注了 ${name}`
}

/** An account's page on its platform, by the entity type in its key. */
export function nodeURL(node: GraphNode): string | undefined {
  let type: string
  try {
    type = decodeURIComponent(node.key.split('/', 3)[1] ?? '')
  } catch {
    return undefined
  }
  return profileURL({
    type,
    username: node.username,
    external_id: node.external_id,
  })
}

/** The badge's words, for its label: the same, shortly. */
export const viewerLabels: Record<ViewerRelation, string> = {
  mutual: '互关',
  following: '已关注',
  follower: '关注者',
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
