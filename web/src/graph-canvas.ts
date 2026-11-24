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
import {
  edgeLook,
  focusOf,
  layoutKind,
  linkedAccounts,
  nodeOpacity,
  type Focus,
  type GraphEdgeView,
  type GraphModel,
  type GraphNodeView,
  type ViewerRelation,
} from './graph'
import {
  LABEL_GAP,
  LABEL_HEIGHT,
  placeLabels,
  type LabelCandidate,
} from './graph-labels'
import { ringLayout, stretchToAspect } from './graph-layout'
import type { LayoutRequest, LayoutUpdate } from './graph-layout.worker'

/**
 * The image layer reads its URL from the node's display data; its variable
 * is not among the typed style properties.
 */
const imageStyle: object = { image: { attribute: 'image' } }

const FONT =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

// The WebGL canvas of the follow graph: sigma draws, the layout module or
// a worker places. Imported only by the graph page, on demand, with sigma
// and graphology.

export interface GraphTheme {
  text: string
  page: string
  fill: string
  center: string
  following: string
  followers: string
  mutual: string
  /** Follows among the others. */
  peer: string
  /** The stage behind the graph, outlining names over edges. */
  card: string
  /** The viewer's badge: apart from every ring colour. */
  viewer: string
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
    card: token('--card', '#fff'),
    fill: token('--fill', '#e6e6ec'),
    center: token('--link', '#3390ec'),
    following: dark ? '#5aa9f0' : '#2f7fd8',
    followers: dark ? '#f0a35a' : '#d9822b',
    mutual: dark ? '#5fcf8a' : '#2e9e5b',
    peer: dark ? '#b9a4f5' : '#6a4fc9',
    viewer: dark ? '#ff6b9a' : '#d6336c',
  } satisfies GraphTheme
}

interface NodeAttributes {
  x: number
  y: number
  size: number
  color: string
  image: string
  caption: string
  center: boolean
  kind: string
  initial: string
  followers: number
  /** The viewer's relation to it, or ''. */
  mark: string
  [key: string]: unknown
}

interface EdgeAttributes {
  kind: GraphEdgeView['kind']
  mutual: boolean
  [key: string]: unknown
}

export interface GraphCanvas {
  /** Show these nodes and edges, placed afresh and framed. */
  show: (model: GraphModel) => void
  /** Mark one node as chosen, or none. */
  select: (key: string | undefined) => void
  /** Fade the accounts the viewer has no relation to. */
  setDim: (dim: boolean) => void
  setTheme: (theme: GraphTheme) => void
  /** Follow a change of the container's size. */
  resize: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Frame every node. */
  fit: () => void
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
  // Large enough to stay sharp on a high-density screen, zoomed in.
  const side = 192
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = side
  const g = canvas.getContext('2d')
  if (!g) return ''
  g.fillStyle = theme.fill
  g.beginPath()
  g.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = theme.text
  g.font = `600 ${side * 0.46}px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(initial, side / 2, side * 0.53)
  url = canvas.toDataURL('image/png')
  cache.set(key, url)
  return url
}

/** Accounts the viewer has no relation to, when those are faded. */
const DIMMED = 0.15

/** The ring a node goes in: the kinds of a profile's graph only. */
const ringKind = (kind: GraphNodeView['kind']) =>
  kind && kind !== 'shared' ? { kind } : {}

/**
 * The viewer's badge on an avatar: a filled one with a heart for a mutual
 * follow, with a check when the viewer follows it, and an outlined one
 * with a dot when it follows the viewer.
 */
function drawMark(
  g: CanvasRenderingContext2D,
  relation: ViewerRelation,
  at: { x: number; y: number; r: number; color: string; card: string },
) {
  const { x, y, r } = at
  g.save()
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fillStyle = relation === 'follower' ? at.card : at.color
  g.fill()
  g.lineWidth = Math.max(1.5, r * 0.22)
  g.strokeStyle = relation === 'follower' ? at.color : at.card
  g.stroke()
  if (relation === 'mutual') {
    // A heart.
    const s = r * 0.52
    g.beginPath()
    g.moveTo(x, y + s * 0.85)
    g.bezierCurveTo(
      x - s * 1.3,
      y - s * 0.1,
      x - s * 0.6,
      y - s * 1.1,
      x,
      y - s * 0.4,
    )
    g.bezierCurveTo(
      x + s * 0.6,
      y - s * 1.1,
      x + s * 1.3,
      y - s * 0.1,
      x,
      y + s * 0.85,
    )
    g.fillStyle = at.card
    g.fill()
  } else if (relation === 'following') {
    g.beginPath()
    g.moveTo(x - r * 0.42, y + r * 0.02)
    g.lineTo(x - r * 0.1, y + r * 0.34)
    g.lineTo(x + r * 0.45, y - r * 0.3)
    g.lineWidth = Math.max(1.5, r * 0.26)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.strokeStyle = at.card
    g.stroke()
  } else {
    g.beginPath()
    g.arc(x, y, r * 0.32, 0, Math.PI * 2)
    g.fillStyle = at.color
    g.fill()
  }
  g.restore()
}

export function createGraphCanvas(
  container: HTMLElement,
  options: { theme: GraphTheme; onSelect: (key: string | undefined) => void },
): GraphCanvas {
  let theme = options.theme
  let dim = false
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
          layerImage({ imageAttribute: 'image', padding: 0.11 }),
        ],
      },
      edges: {
        paths: [pathLine()],
        extremities: [extremityArrow()],
        layers: [layerPlain()],
      },
    },
    styles: {
      nodes: [
        {
          x: { attribute: 'x' },
          y: { attribute: 'y' },
          size: { attribute: 'size' },
          color: (attributes) => nodeColor(attributes),
          ...imageStyle,
          opacity: (attributes, state, graphState) =>
            dim && !attributes.mark && !state.isHighlighted
              ? DIMMED
              : nodeOpacity({
                  highlighted: state.isHighlighted,
                  focusing: graphState.hasHighlighted,
                }),
          depth: (_attributes, state) =>
            state.isHighlighted || state.isHovered ? 'topNodes' : 'nodes',
        },
      ],
      edges: [
        {
          color: (attributes) => edgeColor(attributes.kind),
          visibility: (attributes, state, graphState) =>
            edgeLook(attributes.kind, {
              highlighted: state.isHighlighted,
              focusing: graphState.hasHighlighted,
            }).visible
              ? 'visible'
              : 'hidden',
          size: (attributes, state, graphState) =>
            edgeLook(attributes.kind, {
              highlighted: state.isHighlighted,
              focusing: graphState.hasHighlighted,
            }).size,
          opacity: (attributes, state, graphState) =>
            edgeLook(attributes.kind, {
              highlighted: state.isHighlighted,
              focusing: graphState.hasHighlighted,
            }).opacity,
          head: (attributes) => (attributes.mutual ? 'none' : 'arrow'),
          depth: (_attributes, state) =>
            state.isHighlighted ? 'topEdges' : 'edges',
        },
      ],
    },
    settings: {
      gestureTarget: 'graph',
      enableNodeDrag: false,
      enableCameraRotation: false,
      // Sizes are in layout units and grow with the zoom, like the gaps
      // between them: zooming in makes room for names.
      itemSizesReference: 'positions',
      zoomToSizeRatioFunction: (ratio) => ratio,
      // Names are drawn by the label layer below, not by sigma.
      renderLabels: false,
      minCameraRatio: 0.08,
      maxCameraRatio: 2,
      stagePadding: 28,
      // A cached page is kept hidden, with no size, until shown again.
      allowInvalidContainer: true,
      // Frame the avatars, not only their centers.
      autoRescaleContent: 'nodes',
    },
  })
  sigma.on('clickNode', ({ node }) => options.onSelect(node))
  sigma.on('clickStage', () => options.onSelect(undefined))

  let model: GraphModel = { nodes: [], edges: [] }
  let selected: string | undefined
  let hovered: string | undefined
  let focus: Focus | undefined
  sigma.on('enterNode', ({ node }) => {
    hovered = node
    applyFocus()
  })
  sigma.on('leaveNode', () => {
    hovered = undefined
    applyFocus()
  })

  /** Bring the hovered (or else the chosen) account and its follows forward. */
  function applyFocus() {
    const key = hovered ?? selected
    if (focus) {
      sigma.setNodesState(
        [...focus.nodes].filter((n) => graph.hasNode(n)),
        { isHighlighted: false },
      )
      sigma.setEdgesState(
        [...focus.edges].filter((e) => graph.hasEdge(e)),
        { isHighlighted: false },
      )
    }
    focus = focusOf(model, key)
    sigma.scheduleRender()
    if (!focus) return
    sigma.setNodesState(
      [...focus.nodes].filter((n) => graph.hasNode(n)),
      { isHighlighted: true },
    )
    sigma.setEdgesState(
      [...focus.edges].filter((e) => graph.hasEdge(e)),
      { isHighlighted: true },
    )
  }

  // Names in 2D over the WebGL canvas (see graph-labels.ts for why).
  const names = document.createElement('canvas')
  names.className = 'graph-names'
  Object.assign(names.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  })
  container.append(names)
  const widths = new Map<string, number>()
  const LABEL_FONT = `500 12px ${FONT}`
  sigma.on('afterRender', drawNames)

  function drawNames() {
    const { width, height } = sigma.getDimensions()
    // The pixel ratio sigma draws the avatars at.
    const ratio = sigma.getRenderParams().pixelRatio || 1
    const w = Math.round(width * ratio)
    const h = Math.round(height * ratio)
    if (names.width !== w || names.height !== h) {
      names.width = w
      names.height = h
    }
    const g = names.getContext('2d')
    if (!g) return
    g.setTransform(ratio, 0, 0, ratio, 0, 0)
    g.clearRect(0, 0, width, height)
    if (!width || !height) return
    g.font = LABEL_FONT
    const key = hovered ?? selected
    const candidates: LabelCandidate[] = []
    graph.forEachNode((node, a) => {
      const data = sigma.getNodeDisplayData(node)
      if (!data) return
      const at = sigma.framedGraphToViewport(data)
      let measured = widths.get(a.caption)
      if (measured === undefined) {
        measured = g.measureText(a.caption).width
        widths.set(a.caption, measured)
      }
      candidates.push({
        key: node,
        text: a.caption,
        x: at.x,
        y: at.y,
        radius: sigma.scaleSize(data.size),
        width: measured,
        forced: node === key || a.center,
        // The focused account, then its neighbours, the center, then by followers.
        priority:
          node === hovered
            ? 4e9
            : node === selected
              ? 3e9
              : a.center
                ? 2e9
                : focus?.nodes.has(node)
                  ? 1e9 + a.followers
                  : a.followers,
        hidden: !!focus && !focus.nodes.has(node) && !a.center,
      })
    })
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.lineJoin = 'round'
    g.lineWidth = 3
    for (const label of placeLabels(candidates, { width, height })) {
      if (label.forced) {
        // Over other avatars, on a plate of the stage's colour.
        g.fillStyle = theme.card
        g.shadowColor = 'rgba(0, 0, 0, 0.25)'
        g.shadowBlur = 4
        g.beginPath()
        g.roundRect(
          label.x - label.width / 2 - 6,
          label.y - 1,
          label.width + 12,
          LABEL_HEIGHT + 2,
          8,
        )
        g.fill()
        g.shadowBlur = 0
        g.shadowColor = 'transparent'
      } else {
        g.strokeStyle = theme.card
        g.strokeText(label.text, label.x, label.y + 1)
      }
      g.fillStyle = theme.text
      g.fillText(label.text, label.x, label.y + 1)
    }
    graph.forEachNode((node, a) => {
      if (!a.mark) return
      if (focus && !focus.nodes.has(node)) return
      const data = sigma.getNodeDisplayData(node)
      if (!data) return
      const radius = sigma.scaleSize(data.size)
      if (radius < 7) return
      const at = sigma.framedGraphToViewport(data)
      drawMark(g, a.mark as ViewerRelation, {
        // On the avatar's rim, at its top right.
        x: at.x + radius * 0.71,
        y: at.y - radius * 0.71,
        r: Math.min(11, Math.max(5.5, radius * 0.34)),
        color: theme.viewer,
        card: theme.card,
      })
    })
  }

  const worker = new Worker(
    new URL('graph-layout.worker.ts', import.meta.url),
    { type: 'module' },
  )
  let run = 0
  let order: string[] = []
  worker.addEventListener('message', (event: MessageEvent<LayoutUpdate>) => {
    const { positions } = event.data
    if (event.data.run !== run) return
    placeAround(positions)
  })

  function imageOf(node: GraphModel['nodes'][number]) {
    return node.image ?? initialImage(node.initial, theme, initials)
  }

  /** The shape the graph is framed in: the stage less sigma's padding. */
  function aspect() {
    const { width, height } = sigma.getDimensions()
    const pad = sigma.getStagePadding() * 2
    return width > pad && height > pad ? (width - pad) / (height - pad) : 1
  }

  function show(next: GraphModel) {
    applyFocusClear()
    model = next
    graph.clear()
    for (const node of model.nodes)
      graph.addNode(node.key, {
        x: 0,
        y: 0,
        color: '',
        size: node.size,
        image: imageOf(node),
        caption: node.caption,
        center: node.center,
        kind: node.kind ?? '',
        initial: node.initial,
        followers: node.node.followers ?? -1,
        mark: node.viewer ?? '',
        // Not a style input: initials are redrawn from it on a theme change.
        avatar: node.image ?? '',
      })
    for (const edge of model.edges)
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target))
        graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target, {
          kind: edge.kind,
          mutual: edge.mutual,
        })
    layout()
    applyFocus()
  }

  function applyFocusClear() {
    hovered = undefined
    focus = undefined
  }

  let placedAspect = 0
  let placedKind: 'rings' | 'force' | 'given' = 'rings'
  /**
   * Rings at once; the force layout starts from them in the worker, and
   * the rings stand until it is done.
   */
  function layout() {
    run++
    placedAspect = aspect()
    if (model.positions) {
      // Given places take the canvas's shape, only ever spread apart.
      const given = [...model.positions].map(([key, p]) => ({ key, ...p }))
      stretchToAspect(given, placedAspect)
      for (const { key, x, y } of given)
        if (graph.hasNode(key)) graph.mergeNodeAttributes(key, { x, y })
      placedKind = 'given'
      fit(false)
      return
    }
    placedKind = layoutKind(model)
    const rings = ringLayout(
      model.nodes.map((node) => ({
        key: node.key,
        size: node.size,
        center: node.center,
        ...ringKind(node.kind),
        ...(node.node.followers === undefined
          ? {}
          : { followers: node.node.followers }),
      })),
      placedAspect,
    )
    for (const [key, point] of rings)
      if (graph.hasNode(key))
        graph.mergeNodeAttributes(key, { x: point.x, y: point.y })
    fit(false)
    if (placedKind === 'rings') return
    // The force layout places the core: the center and the accounts with
    // follows among the others. The rest go around it afterwards.
    const linked = linkedAccounts(model)
    order = model.nodes
      .filter((node) => node.center || linked.has(node.key))
      .map((node) => node.key)
    const core = new Set(order)
    // Follows among the others shape the circles; those with the center
    // only hold the core together.
    const edges: LayoutRequest['edges'] = []
    graph.forEachEdge((_edge, attributes, source, target) => {
      if (core.has(source) && core.has(target))
        edges.push([source, target, attributes.kind === 'peer' ? 1 : 0.05])
    })
    const request: LayoutRequest = {
      run,
      nodes: order.map((key) => {
        const a = graph.getNodeAttributes(key)
        return { key, x: a.x, y: a.y, size: a.size, fixed: a.center }
      }),
      edges,
      aspect: placedAspect,
    }
    worker.postMessage(request)
  }

  /** The core where the force layout put it, the others in rings around. */
  function placeAround(positions: Float32Array) {
    const core = order.map((key, i) => ({
      key,
      x: positions[i * 2]!,
      y: positions[i * 2 + 1]!,
      size: graph.hasNode(key) ? graph.getNodeAttribute(key, 'size') : 0,
    }))
    const inCore = new Set(order)
    const around = ringLayout(
      model.nodes
        .filter((node) => !inCore.has(node.key))
        .map((node) => ({
          key: node.key,
          size: node.size,
          ...ringKind(node.kind),
          ...(node.node.followers === undefined
            ? {}
            : { followers: node.node.followers }),
        })),
      placedAspect,
      core,
    )
    for (const point of core)
      if (graph.hasNode(point.key))
        graph.mergeNodeAttributes(point.key, { x: point.x, y: point.y })
    for (const [key, point] of around)
      if (graph.hasNode(key))
        graph.mergeNodeAttributes(key, { x: point.x, y: point.y })
    fit(false)
  }

  /**
   * The camera that frames every avatar and the names under the bottom
   * row tightly: sigma's own framing (ratio 1) leaves room to spare.
   */
  function home() {
    const base = { x: 0.5, y: 0.5, ratio: 1, angle: 0 }
    const { width, height } = sigma.getDimensions()
    const pad = sigma.getStagePadding()
    // Positions as they are now, not as last drawn.
    sigma.refresh()
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    graph.forEachNode((node) => {
      const data = sigma.getNodeDisplayData(node)
      if (!data) return
      const at = sigma.framedGraphToViewport(data, { cameraState: base })
      const r = sigma.scaleSize(data.size, 1)
      left = Math.min(left, at.x - r)
      right = Math.max(right, at.x + r)
      top = Math.min(top, at.y - r)
      bottom = Math.max(bottom, at.y + r + LABEL_GAP + LABEL_HEIGHT)
    })
    const k = Math.max(
      (right - left) / (width - pad * 2),
      (bottom - top) / (height - pad * 2),
    )
    if (!(k > 0) || !Number.isFinite(k)) return base
    // Sizes grow with the zoom like distances, so the extent scales by k.
    const middle = sigma.viewportToFramedGraph(
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { cameraState: base },
    )
    return { ...middle, ratio: k, angle: 0 }
  }

  function fit(animate = true) {
    const camera = sigma.getCamera()
    const target = home()
    if (animate) void camera.animate(target, { duration: 250 })
    else camera.setState(target)
  }

  function select(key: string | undefined) {
    selected = key && graph.hasNode(key) ? key : undefined
    applyFocus()
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

  function setDim(next: boolean) {
    dim = next
    sigma.refresh()
  }

  return {
    show,
    select,
    setDim,
    setTheme,
    resize: () => {
      sigma.resize()
      // Rings and given places take the new shape; a force layout keeps
      // its own.
      const now = aspect()
      if (
        placedKind !== 'force' &&
        model.nodes.length &&
        Math.abs(now / placedAspect - 1) > 0.08
      )
        layout()
    },
    zoomIn() {
      void sigma.getCamera().zoomIn({ factor: 1.5, duration: 200 })
    },
    zoomOut() {
      void sigma.getCamera().zoomOut({ factor: 1.5, duration: 200 })
    },
    fit: () => fit(),
    kill() {
      worker.terminate()
      sigma.kill()
      names.remove()
    },
  }
}
