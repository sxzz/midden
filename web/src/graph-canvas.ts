import { layerImage } from '@sigma/node-image'
import Graph from 'graphology'
import Sigma from 'sigma'
import {
  extremityArrow,
  layerFill,
  layerPlain,
  pathLine,
  sdfCircle,
} from 'sigma/rendering'
import type { GraphEdgeView, GraphModel, GraphNodeView } from './graph'
import type { LayoutRequest, LayoutUpdate } from './graph-layout.worker'

/**
 * The image layer reads its URL from the node's display data; its variable
 * is not among the typed style properties.
 */
const imageStyle: object = { image: { attribute: 'image' } }

// The WebGL canvas of the follow graph: sigma draws, a worker lays out.
// Imported only by the graph page, on demand, with sigma and graphology.

export interface GraphTheme {
  text: string
  page: string
  fill: string
  center: string
  following: string
  followers: string
  mutual: string
  peer: string
}

/** The page's colours, read from its CSS tokens (Telegram's or ours). */
export function readTheme(element: Element = document.documentElement) {
  const style = getComputedStyle(element)
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback
  const dark = style.colorScheme === 'dark'
  return {
    text: token('--text', '#000'),
    page: token('--page', '#efeff4'),
    fill: token('--fill', '#e6e6ec'),
    center: token('--link', '#3390ec'),
    following: dark ? '#5aa9f0' : '#2f7fd8',
    followers: dark ? '#f0a35a' : '#d9822b',
    mutual: dark ? '#5fcf8a' : '#2e9e5b',
    peer: token('--subtle', '#707579'),
  } satisfies GraphTheme
}

interface NodeAttributes {
  x: number
  y: number
  size: number
  color: string
  image: string
  label: string
  center: boolean
  kind: string
  initial: string
  [key: string]: unknown
}

interface EdgeAttributes {
  kind: string
  mutual: boolean
  [key: string]: unknown
}

export interface GraphCanvas {
  /** Show these nodes and edges; ones already shown keep their place. */
  show: (model: GraphModel) => void
  /** Mark one node as chosen, or none. */
  select: (key: string | undefined) => void
  setTheme: (theme: GraphTheme) => void
  /** Follow a change of the container's size. */
  resize: () => void
  kill: () => void
}

/** A round picture of an initial, for an account without avatar. */
function initialImage(
  initial: string,
  theme: GraphTheme,
  cache: Map<string, string>,
) {
  const key = `${initial}|${theme.fill}|${theme.text}`
  let url = cache.get(key)
  if (url) return url
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 96
  const g = canvas.getContext('2d')
  if (!g) return ''
  g.fillStyle = theme.fill
  g.beginPath()
  g.arc(48, 48, 48, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = theme.text
  g.font =
    '600 46px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(initial, 48, 51)
  url = canvas.toDataURL('image/png')
  cache.set(key, url)
  return url
}

/** A starting place: the center in the middle, each kind in its sector. */
function seed(node: GraphNodeView, index: number) {
  if (node.center) return { x: 0, y: 0 }
  const sector = { following: 0, mutual: 1, followers: 2 }[
    node.kind ?? 'mutual'
  ]
  const angle =
    ((sector + ((index * 0.618) % 1)) / 3) * Math.PI * 2 + Math.random() * 0.2
  const radius = 40 + Math.random() * 60
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

export function createGraphCanvas(
  container: HTMLElement,
  options: { theme: GraphTheme; onSelect: (key: string | undefined) => void },
): GraphCanvas {
  let theme = options.theme
  const initials = new Map<string, string>()
  const graph = new Graph<NodeAttributes, EdgeAttributes>({
    type: 'directed',
  })
  const edgeColor = (kind: string) =>
    kind === 'following' || kind === 'followers' || kind === 'mutual'
      ? theme[kind]
      : theme.peer
  const nodeColor = (attributes: NodeAttributes) =>
    attributes.center ? theme.center : edgeColor(attributes.kind)
  const sigma = new Sigma(graph, container, {
    primitives: {
      nodes: {
        shapes: [sdfCircle()],
        // The fill shows as a ring in the kind's colour around the avatar.
        layers: [
          layerFill(),
          layerImage({ imageAttribute: 'image', padding: 0.08 }),
        ],
      },
      edges: {
        paths: [pathLine()],
        extremities: [extremityArrow()],
        layers: [layerPlain()],
      },
    },
    // Sigma's conditional style rules are objects with `then`.
    /* eslint-disable unicorn/no-thenable */
    styles: {
      nodes: [
        {
          x: { attribute: 'x' },
          y: { attribute: 'y' },
          size: { attribute: 'size' },
          color: (attributes) => nodeColor(attributes),
          label: { attribute: 'label' },
          ...imageStyle,
          labelColor: () => theme.text,
          labelSize: 12,
          depth: 'nodes',
        },
        {
          whenState: 'isHighlighted',
          then: { labelVisibility: 'visible', depth: 'topNodes' },
        },
        {
          whenState: 'isHovered',
          then: { labelVisibility: 'visible', depth: 'topNodes' },
        },
      ],
      edges: [
        {
          color: (attributes) => edgeColor(attributes.kind),
          // Edges among the others are thinner and fainter than the center's.
          size: (attributes) => (attributes.kind === 'peer' ? 0.6 : 1.2),
          opacity: (attributes) => (attributes.kind === 'peer' ? 0.3 : 0.75),
          head: (attributes) => (attributes.mutual ? 'none' : 'arrow'),
          depth: 'edges',
        },
        {
          whenState: 'isHighlighted',
          then: { opacity: 1, size: 2, depth: 'topEdges' },
        },
      ],
    },
    /* eslint-enable unicorn/no-thenable */
    settings: {
      gestureTarget: 'graph',
      enableNodeDrag: false,
      labelRenderedSizeThreshold: 14,
      minCameraRatio: 0.03,
      maxCameraRatio: 3,
      stagePadding: 24,
      // A cached page is kept hidden, with no size, until shown again.
      allowInvalidContainer: true,
      itemSizesReference: 'screen',
      // Frame the positions only: long names would shrink the graph.
      autoRescaleContent: 'positions',
    },
  })
  sigma.on('clickNode', ({ node }) => options.onSelect(node))
  sigma.on('clickStage', () => options.onSelect(undefined))

  const worker = new Worker(
    new URL('graph-layout.worker.ts', import.meta.url),
    { type: 'module' },
  )
  let run = 0
  let order: string[] = []
  worker.addEventListener('message', (event: MessageEvent<LayoutUpdate>) => {
    const { positions } = event.data
    if (event.data.run !== run) return
    order.forEach((key, i) => {
      if (!graph.hasNode(key)) return
      graph.mergeNodeAttributes(key, {
        x: positions[i * 2]!,
        y: positions[i * 2 + 1]!,
      })
    })
  })

  function imageOf(node: GraphNodeView) {
    return node.image ?? initialImage(node.initial, theme, initials)
  }

  function show(model: GraphModel) {
    const wanted = new Set(model.nodes.map((n) => n.key))
    for (const key of graph.nodes()) if (!wanted.has(key)) graph.dropNode(key)
    model.nodes.forEach((node, index) => {
      const attributes = {
        size: node.size,
        image: imageOf(node),
        label: node.label,
        center: node.center,
        kind: node.kind ?? '',
        initial: node.initial,
        // Not a style input: initials are redrawn from it on a theme change.
        avatar: node.image ?? '',
      }
      if (graph.hasNode(node.key))
        graph.mergeNodeAttributes(node.key, attributes)
      else
        graph.addNode(node.key, {
          ...seed(node, index),
          color: '',
          ...attributes,
        })
    })
    graph.clearEdges()
    for (const edge of model.edges) addEdge(edge)
    layout()
  }

  function addEdge(edge: GraphEdgeView) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return
    graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target, {
      kind: edge.kind,
      mutual: edge.mutual,
    })
  }

  function layout() {
    run++
    order = graph.nodes()
    const request: LayoutRequest = {
      run,
      nodes: order.map((key) => {
        const a = graph.getNodeAttributes(key)
        return { key, x: a.x, y: a.y, size: a.size, fixed: a.center }
      }),
      edges: graph.mapEdges((_edge, _attributes, source, target) => [
        source,
        target,
      ]),
    }
    worker.postMessage(request)
  }

  let selected: string | undefined
  function select(key: string | undefined) {
    if (selected && graph.hasNode(selected)) {
      sigma.setNodeState(selected, { isHighlighted: false })
      sigma.setEdgesState(graph.edges(selected), { isHighlighted: false })
    }
    selected = key && graph.hasNode(key) ? key : undefined
    if (!selected) {
      return
    }

    sigma.setNodeState(selected, { isHighlighted: true })
    sigma.setEdgesState(graph.edges(selected), { isHighlighted: true })
  }

  function setTheme(next: GraphTheme) {
    theme = next
    graph.forEachNode((key, a) => {
      if (!a.avatar)
        graph.setNodeAttribute(
          key,
          'image',
          initialImage(a.initial, theme, initials),
        )
    })
    sigma.refresh()
  }

  return {
    show,
    select,
    setTheme,
    resize: () => {
      sigma.resize()
    },
    kill() {
      worker.terminate()
      sigma.kill()
    },
  }
}
