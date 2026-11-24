import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

// ForceAtlas2 off the main thread, so pinch and pan stay smooth while the
// graph settles. The library's own worker starts from a blob URL, which the
// app's Content-Security-Policy refuses; this one is a bundled module.

export interface LayoutRequest {
  run: number
  /** Positions to start from; `fixed` ones stay (the center). */
  nodes: { key: string; x: number; y: number; size: number; fixed?: boolean }[]
  edges: [string, string][]
}

export interface LayoutUpdate {
  run: number
  /** x and y of each node, in the order asked. */
  positions: Float32Array
  done: boolean
}

/** Fewer rounds for big graphs: each one costs more there. */
const rounds = (order: number) => (order > 2000 ? 120 : order > 500 ? 200 : 300)
const STEP = 15

let current = 0

addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  const { run, nodes, edges } = event.data
  current = run
  const graph = new Graph({ type: 'undirected' })
  for (const node of nodes) graph.addNode(node.key, node)
  for (const [a, b] of edges)
    if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b)
  const settings = {
    ...forceAtlas2.inferSettings(graph),
    // Hubs (the center) spread their neighbours instead of pulling them in.
    outboundAttractionDistribution: true,
    // Room between accounts for their avatars.
    scalingRatio: 8,
    barnesHutOptimize: graph.order > 400,
  }
  const total = rounds(graph.order)
  let done = 0
  const post = () => {
    const positions = new Float32Array(nodes.length * 2)
    nodes.forEach((node, i) => {
      positions[i * 2] = graph.getNodeAttribute(node.key, 'x')
      positions[i * 2 + 1] = graph.getNodeAttribute(node.key, 'y')
    })
    const update: LayoutUpdate = { run, positions, done: done >= total }
    postMessage(update, { transfer: [positions.buffer] })
  }
  // Steps between messages, yielding so a newer request can take over.
  const step = () => {
    if (current !== run) return
    forceAtlas2.assign(graph, { iterations: STEP, settings })
    done += STEP
    post()
    if (done < total) setTimeout(step, 0)
  }
  step()
})
