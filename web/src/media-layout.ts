/**
 * How inline media is boxed. A box takes the media's own aspect ratio, so
 * nothing is letterboxed and the group is only as tall as what it shows;
 * the clamps below keep extreme shapes usable.
 */

/**
 * The narrowest shape a box follows: 1:3. Taller media is held to it and
 * contained. Anything above that is a tall box, and the height cap narrows
 * it (see `--media-max-height`) instead of cropping or barring the media.
 */
export const MIN_RATIO = 1 / 3
/** The widest: a 6:1 box is still about 60px tall on a phone. */
export const MAX_RATIO = 6
/** Reserved before an image's shape is known, and for media without one. */
export const UNKNOWN_RATIO = 4 / 3
/**
 * Side by side, each of two items is held to this range, so a panorama does
 * not shrink its neighbour to a sliver.
 */
const PAIR_MIN_RATIO = MIN_RATIO
const PAIR_MAX_RATIO = 2.5
/**
 * Two items share a row only while their ratios add up to at most this: the
 * row is then at least a third as tall as it is wide (about 120px on a
 * phone). Wider pairs are stacked, each as wide as the group.
 */
export const PAIR_MAX_SUM = 3
/** Where a removed item's label still fits. */
export const REMOVED_MAX_RATIO = 3
export const REMOVED_MIN_RATIO = 0.75

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** The aspect ratio of what an asset's size describes, if it has one. */
export function ratioOf(size: { width?: number; height?: number }) {
  return size.width && size.height ? size.width / size.height : undefined
}

export interface LayoutItem {
  /** Width over height; undefined while unknown. */
  ratio?: number
  /** Whether the item is a media box; notices and file links are not. */
  box?: boolean
}

export interface LayoutCell<T> {
  item: T
  /**
   * The cell's share of the row's width (`fr`), which is also the cell's own
   * aspect ratio: widths in proportion to the ratios give equal heights.
   */
  flex: number
}

export interface LayoutRow<T> {
  /** Width over height of the whole row; undefined for a plain item. */
  ratio?: number
  cells: LayoutCell<T>[]
}

/**
 * A single item's box: its own ratio within [MIN_RATIO, MAX_RATIO]. The media
 * is always contained, never cropped; past the limits that leaves bars.
 */
export const singleBox = (ratio = UNKNOWN_RATIO) =>
  clamp(ratio, MIN_RATIO, MAX_RATIO)

function pairRow<T extends LayoutItem>(a: T, b: T): LayoutRow<T> | undefined {
  const ra = clamp(a.ratio ?? UNKNOWN_RATIO, PAIR_MIN_RATIO, PAIR_MAX_RATIO)
  const rb = clamp(b.ratio ?? UNKNOWN_RATIO, PAIR_MIN_RATIO, PAIR_MAX_RATIO)
  if (ra + rb > PAIR_MAX_SUM) return
  // Widths in proportion to the ratios give both cells the same height.
  return {
    ratio: ra + rb,
    cells: [
      { item: a, flex: ra },
      { item: b, flex: rb },
    ],
  }
}

function single<T extends LayoutItem>(item: T): LayoutRow<T> {
  if (item.box === false) return { cells: [{ item, flex: 1 }] }
  const ratio = singleBox(item.ratio)
  // A single cell's share is its ratio too, as the cell's own box needs.
  return { ratio, cells: [{ item, flex: ratio }] }
}

/**
 * Rows for a group of media, in order. One item gets a box of its own
 * shape. More are taken two at a time: a pair shares a row, both at the
 * same height, unless they are so wide that the row would be a strip, in
 * which case each gets a row. An odd last item has a row to itself.
 */
export function layoutMedia<T extends LayoutItem>(items: T[]): LayoutRow<T>[] {
  const rows: LayoutRow<T>[] = []
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!
    const b = items[i + 1]
    const pair =
      b && a.box !== false && b.box !== false ? pairRow(a, b) : undefined
    if (pair) {
      rows.push(pair)
      i++
    } else rows.push(single(a))
  }
  return rows
}

/**
 * A grid track sized in proportion to `share`. Scaled up because `fr`
 * values that add up to less than 1 take only that part of the space: a
 * lone portrait (a share of 0.56) would be a narrow strip in a wide row.
 */
export const track = (share: number) =>
  `minmax(0, ${+(share * 1000).toFixed(3)}fr)`
