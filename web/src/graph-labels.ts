// Which names the graph writes under avatars, and where: free of the DOM so
// it tests as is. The canvas draws them in 2D over sigma's WebGL. Sigma's
// own labels come from one glyph atlas page; past a few hundred distinct
// characters (Chinese names fill it fast, sooner on a high-density screen)
// the glyphs beyond it are read from the wrong place and show as other
// characters, or two overlapping.

export interface LabelCandidate {
  key: string
  text: string
  /** The avatar's center and radius on screen, in CSS pixels. */
  x: number
  y: number
  radius: number
  /** Measured text width, in CSS pixels. */
  width: number
  /** Written whatever the zoom and room: the center, hovered, chosen. */
  forced: boolean
  /** Higher first, when there is not room for all. */
  priority: number
  /** Not drawn at all (outside the focus while there is one). */
  hidden?: boolean
}

export interface PlacedLabel {
  key: string
  text: string
  /** The text's top center. */
  x: number
  y: number
  width: number
  /** May lie over other avatars, so drawn on a background. */
  forced: boolean
}

/** The line a name takes, and the gap under its avatar. */
export const LABEL_HEIGHT = 15
export const LABEL_GAP = 3
/** Avatars smaller than this (radius, px) are not named unless forced. */
export const LABEL_MIN_RADIUS = 13

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

function circleHits(box: Box, c: LabelCandidate) {
  const nx = Math.max(box.left, Math.min(c.x, box.right))
  const ny = Math.max(box.top, Math.min(c.y, box.bottom))
  return Math.hypot(nx - c.x, ny - c.y) < c.radius
}

/**
 * Names under avatars that never overlap one another, nor (unless forced)
 * another avatar: forced ones first, then by priority, each kept only
 * where it is free.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  viewport: { width: number; height: number },
): PlacedLabel[] {
  const cell = 64
  // Avatars by grid cell, to find the ones a label would cover.
  const grid = new Map<string, LabelCandidate[]>()
  const cells = (box: Box, visit: (key: string) => void) => {
    for (
      let gx = Math.floor(box.left / cell);
      gx <= Math.floor(box.right / cell);
      gx++
    )
      for (
        let gy = Math.floor(box.top / cell);
        gy <= Math.floor(box.bottom / cell);
        gy++
      )
        visit(`${gx},${gy}`)
  }
  for (const c of candidates)
    cells(
      {
        left: c.x - c.radius,
        right: c.x + c.radius,
        top: c.y - c.radius,
        bottom: c.y + c.radius,
      },
      (key) => {
        const list = grid.get(key)
        if (list) list.push(c)
        else grid.set(key, [c])
      },
    )
  const ordered = candidates
    .filter((c) => !c.hidden && c.text)
    .toSorted(
      (a, b) =>
        Number(b.forced) - Number(a.forced) ||
        b.priority - a.priority ||
        b.radius - a.radius,
    )
  const placed: PlacedLabel[] = []
  const boxes: Box[] = []
  for (const c of ordered) {
    const top = c.y + c.radius + LABEL_GAP
    const box = {
      left: c.x - c.width / 2 - 2,
      right: c.x + c.width / 2 + 2,
      top,
      bottom: top + LABEL_HEIGHT,
    }
    if (boxes.some((other) => overlaps(box, other))) continue
    if (!c.forced) {
      if (c.radius < LABEL_MIN_RADIUS) continue
      if (
        box.right < 0 ||
        box.left > viewport.width ||
        box.bottom < 0 ||
        box.top > viewport.height
      )
        continue
      let covers = false
      cells(box, (key) => {
        if (covers) return
        covers = (grid.get(key) ?? []).some(
          (other) => other !== c && circleHits(box, other),
        )
      })
      if (covers) continue
    }
    boxes.push(box)
    placed.push({
      key: c.key,
      text: c.text,
      x: c.x,
      y: top,
      width: c.width,
      forced: c.forced,
    })
  }
  return placed
}
