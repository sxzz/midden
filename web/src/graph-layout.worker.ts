import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { settle } from './graph-layout'

// ForceAtlas2 off the main thread, so pinch and pan stay smooth while the
// graph settles. The library's own worker starts from a blob URL, which the
// app's Content-Security-Policy refuses; this one is a bundled module.

export interface LayoutRequest {
  run: number
  /** Positions to start from; `fixed` ones stay (the center). */
  nodes: { key: string; x: number; y: number; size: number; fixed?: boolean }[]
  /** Source, target and how strongly the follow pulls them together. */
  edges: [string, string, number][]
  /** The canvas's width over its height, for the final shape. */
  aspect: number
}

export interface LayoutUpdate {
  run: number
  /** x and y of each node, in the order asked, once settled. */
  positions: Float32Array
}

/** Fewer rounds for big graphs: each one costs more there. */
const rounds = (order: number) => (order > 2000 ? 160 : order > 500 ? 300 : 500)
const STEP = 25
/** The last share of rounds, where avatars push apart by their size. */
const SIZED = 0.2

let current = 0

addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  const { run, nodes, edges, aspect } = event.data
  current = run
  const graph = new Graph({ type: 'undirected' })
  // From scattered places, the same each time (a golden-angle spiral):
  // started from the rings, a circle's accounts sit all around them and
  // get stuck between the other circles.
  nodes.forEach((node, i) => {
    const r = node.fixed ? 0 : 10 * Math.sqrt(i + 1)
    graph.addNode(node.key, {
      ...node,
      x: node.fixed ? node.x : r * Math.cos(i * 2.39996),
      y: node.fixed ? node.y : r * Math.sin(i * 2.39996),
    })
  })
  for (const [a, b, weight] of edges)
    if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b, { weight })
  const base = {
    ...forceAtlas2.inferSettings(graph),
    // LinLog separates circles more than the default model; follows with
    // the center pull weakly, so they do not crush everyone into one disc.
    linLogMode: true,
    outboundAttractionDistribution: true,
    edgeWeightInfluence: 1,
    scalingRatio: 6,
    gravity: 0.5,
    barnesHutOptimize: graph.order > 400,
  }
  const total = rounds(graph.order)
  let done = 0
  const post = () => {
    const points = nodes.map((node) => ({
      x: graph.getNodeAttribute(node.key, 'x') as number,
      y: graph.getNodeAttribute(node.key, 'y') as number,
    }))
    settle(
      points,
      nodes.map((node) => node.size),
      nodes.map((node) => !!node.fixed),
      aspect,
    )
    const positions = new Float32Array(nodes.length * 2)
    points.forEach((point, i) => {
      positions[i * 2] = point.x
      positions[i * 2 + 1] = point.y
    })
    const update: LayoutUpdate = { run, positions }
    postMessage(update, { transfer: [positions.buffer] })
  }
  // A few rounds at a time, yielding so a newer request can take over.
  // Only the settled layout is sent: the steps before overlap and jump.
  // Sizes count only at the end: from the start they keep accounts from
  // passing each other on the way to their circle.
  const step = () => {
    if (current !== run) return
    const settings = {
      ...base,
      adjustSizes: done >= total * (1 - SIZED),
    }
    forceAtlas2.assign(graph, { iterations: STEP, settings })
    done += STEP
    if (done >= total) post()
    else setTimeout(step, 0)
  }
  step()
})
