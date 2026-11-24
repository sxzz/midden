// Placing the follow graph's nodes, free of sigma and the DOM so it tests
// as is and runs in the layout worker too. Positions are in the units of
// node sizes (radii): sigma draws sizes in graph units, so the space
// between avatars is fixed here and the camera only scales the whole.

/** The graph's kinds, innermost ring first. */
export const ringOrder = ['mutual', 'following', 'followers'] as const

export type RingKind = (typeof ringOrder)[number]

export interface LayoutNode {
  key: string
  size: number
  center?: boolean
  kind?: RingKind
  followers?: number
}

export interface Point {
  x: number
  y: number
}

/** Free space between two avatars, as a share of the bigger radius. */
const GAP = 0.4

/** The canvas's width over its height, kept to what rings can fill. */
export const clampAspect = (aspect: number) =>
  Number.isFinite(aspect) && aspect > 0
    ? Math.min(2.4, Math.max(0.5, aspect))
    : 1

/** Most followers first; accounts without a count last, in their order. */
export function byFollowers<T extends { followers?: number }>(items: T[]) {
  return items
    .map((item, index) => ({ item, index }))
    .toSorted(
      (a, b) =>
        (b.item.followers ?? -1) - (a.item.followers ?? -1) ||
        a.index - b.index,
    )
    .map(({ item }) => item)
}

/** Clockwise from the top (graph y points up), in [0, 2π). */
function clockAngle({ x, y }: Point) {
  const angle = Math.atan2(x, y)
  return angle < 0 ? angle + Math.PI * 2 : angle
}

/**
 * The concentric layout, for when follows among the others are too few to
 * shape the graph: the center in the middle, then a band per kind (互关,
 * 关注, 粉丝) outward. Places come from a hexagonal lattice, so avatars pack
 * tightly with no empty spokes; the bands are rounded rectangles of the canvas's
 * aspect, so a wide screen is filled. Within a band the most followed come
 * first: the inner rows, each clockwise from the top.
 *
 * With a `core` (accounts already placed by the force layout, about the
 * origin), the bands go around it instead of around the center.
 */
export function ringLayout(
  nodes: readonly LayoutNode[],
  aspect = 1,
  core: readonly (Point & { size: number })[] = [],
): Map<string, Point> {
  const positions = new Map<string, Point>()
  const center = core.length ? undefined : nodes.find((node) => node.center)
  if (center) positions.set(center.key, { x: 0, y: 0 })
  const others = nodes.filter((node) => !node.center)
  if (!others.length) return positions
  const radius = Math.max(...others.map((node) => node.size))
  const step = radius * (2 + GAP)
  const dx = step
  // Rows a little further apart than a tight hexagon: names go below.
  const dy = step * 0.92
  const a = clampAspect(aspect)
  const sx = Math.sqrt(a)
  const sy = 1 / sx
  // Clear of the whole core, in the bands' metric: a place is free
  // beyond this. Clear of the center's avatar, by plain distance.
  const clear = radius * (2 + GAP)
  const hole = Math.max(
    0,
    ...core.map((p) =>
      shapeMetric(
        (Math.abs(p.x) + p.size + clear) / sx,
        (Math.abs(p.y) + p.size + clear) / sy,
      ),
    ),
  )
  const centerHole = center ? center.size + radius * (1 + GAP) : 0
  const groups = ringOrder
    .map((kind) => byFollowers(others.filter((node) => node.kind === kind)))
    .filter((group) => group.length)
  const rest = others.filter(
    (node) => !node.kind || !ringOrder.includes(node.kind),
  )
  if (rest.length) groups.push(byFollowers(rest))

  // Enough lattice places for every node, with some to spare.
  let reach = hole + Math.sqrt(((others.length * 1.3 + 30) * dx * dy) / Math.PI)
  for (;;) {
    const places = lattice(reach, dx, dy, sx, sy, hole, centerHole)
    const assigned = assign(groups, places, step)
    if (assigned) {
      for (const [key, point] of assigned) positions.set(key, point)
      return positions
    }
    reach *= 1.5
  }
}

/**
 * Distance in a rounded rectangle's terms (a superellipse): the bands
 * reach further into the canvas's corners than ellipses would, so the
 * same accounts fit at a larger size.
 */
const shapeMetric = (x: number, y: number) =>
  Math.cbrt(Math.abs(x) ** 3 + Math.abs(y) ** 3)

interface Place extends Point {
  /** Distance from the center in the bands' metric. */
  metric: number
}

function lattice(
  reach: number,
  dx: number,
  dy: number,
  sx: number,
  sy: number,
  hole: number,
  centerHole: number,
): Place[] {
  const places: Place[] = []
  const rows = Math.ceil((reach * sy) / dy)
  const columns = Math.ceil((reach * sx) / dx) + 1
  for (let j = -rows; j <= rows; j++) {
    const shift = Math.abs(j) % 2 ? dx / 2 : 0
    for (let i = -columns; i <= columns; i++) {
      const x = i * dx + shift
      const y = j * dy
      const metric = shapeMetric(x / sx, y / sy)
      if (metric > reach || metric < hole || Math.hypot(x, y) < centerHole)
        continue
      places.push({ x, y, metric })
    }
  }
  return places.toSorted(
    (p, q) => p.metric - q.metric || clockAngle(p) - clockAngle(q),
  )
}

/** Each group's nodes on the next places out, or nothing if they run out. */
function assign(
  groups: LayoutNode[][],
  places: Place[],
  step: number,
): Map<string, Point> | undefined {
  const positions = new Map<string, Point>()
  let next = 0
  // Bands touch: the ring colours tell the kinds apart, and a gap between
  // them shows as scattered holes in the lattice, not as a clean line.
  for (const group of groups) {
    if (next + group.length > places.length) return
    const band = places.slice(next, next + group.length)
    next += group.length
    const start = band[0]!.metric
    // Row by row outward, each row clockwise from the top.
    const ordered = band.toSorted(
      (p, q) =>
        Math.floor((p.metric - start) / step) -
          Math.floor((q.metric - start) / step) ||
        clockAngle(p) - clockAngle(q),
    )
    group.forEach((node, i) =>
      positions.set(node.key, { x: ordered[i]!.x, y: ordered[i]!.y }),
    )
  }
  return positions
}

/** Spread the layout to the canvas's aspect, at most twice in one axis. */
export function stretchToAspect(points: Point[], aspect: number) {
  if (points.length < 2) return
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  if (!width || !height) return
  const want = clampAspect(aspect)
  const have = width / height
  // Only ever stretching: nothing comes closer, so nothing new overlaps.
  if (have < want) {
    const k = Math.min(2, want / have)
    for (const p of points) p.x *= k
  } else {
    const k = Math.min(2, have / want)
    for (const p of points) p.y *= k
  }
}

/** The share of a force layout's extent its avatars take, once scaled. */
const FILL = 0.5

/**
 * Scale a force layout about the center to its avatars' size: ForceAtlas2's
 * units have nothing to do with them. Avatars should take a fixed share of
 * the extent: a spread-out layout comes closer, and one whose circles are
 * each piled up on one spot opens up, so that pushing the piles apart
 * after leaves the circles apart too.
 */
export function compact(points: Point[], sizes: number[]) {
  if (points.length < 3) return
  const gap = Math.max(...sizes) * GAP
  const need = sizes.reduce((sum, size) => sum + (2 * size + gap) ** 2, 0)
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  // A line or a point has no area: measure it as a square of its length.
  const area = Math.max(width * height, Math.max(width, height) ** 2 / 4)
  if (!(area > 0)) return
  const k = Math.sqrt(need / FILL / area)
  for (const p of points) {
    p.x *= k
    p.y *= k
  }
}

/**
 * Push overlapping avatars apart until none overlap (or rounds run out).
 * `fixed` ones (the center) do not move; the other of the pair moves all
 * the way.
 */
export function removeOverlaps(
  points: Point[],
  sizes: number[],
  fixed: boolean[] = [],
  rounds = 100,
): number {
  const n = points.length
  if (n < 2) return 0
  const gap = Math.max(...sizes) * GAP * 0.5
  const cell = Math.max(...sizes) * 2 + gap
  let overlaps = 0
  for (let round = 0; round < rounds; round++) {
    overlaps = 0
    const grid = new Map<string, number[]>()
    const cellOf = (p: Point) => [
      Math.floor(p.x / cell),
      Math.floor(p.y / cell),
    ]
    points.forEach((p, i) => {
      const [cx, cy] = cellOf(p)
      const key = `${cx},${cy}`
      const list = grid.get(key)
      if (list) list.push(i)
      else grid.set(key, [i])
    })
    for (let i = 0; i < n; i++) {
      const [cx, cy] = cellOf(points[i]!)
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (const j of grid.get(`${cx! + ox},${cy! + oy}`) ?? []) {
            if (j <= i) continue
            const p = points[i]!
            const q = points[j]!
            const need = sizes[i]! + sizes[j]! + gap
            let ddx = q.x - p.x
            let ddy = q.y - p.y
            let d = Math.hypot(ddx, ddy)
            if (d >= need) continue
            overlaps++
            if (d < 1e-6) {
              // On top of each other: any direction will do, the same each time.
              const angle = (i * 2.399 + j) % (Math.PI * 2)
              ddx = Math.cos(angle)
              ddy = Math.sin(angle)
              d = 1
            }
            const push = need - Math.hypot(q.x - p.x, q.y - p.y)
            const ux = ddx / d
            const uy = ddy / d
            const pi = fixed[i] ? 0 : fixed[j] ? 1 : 0.5
            const pj = fixed[j] ? 0 : fixed[i] ? 1 : 0.5
            p.x -= ux * push * pi
            p.y -= uy * push * pi
            q.x += ux * push * pj
            q.y += uy * push * pj
          }
    }
    if (!overlaps) break
  }
  return overlaps
}

/** After ForceAtlas2: compact, take the canvas's shape, no overlaps. */
export function settle(
  points: Point[],
  sizes: number[],
  fixed: boolean[],
  aspect: number,
) {
  compact(points, sizes)
  removeOverlaps(points, sizes, fixed)
  // About the origin, where the center stays.
  stretchToAspect(points, aspect)
  removeOverlaps(points, sizes, fixed)
}
