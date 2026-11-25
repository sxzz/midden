export interface Size {
  width: number
  height: number
}
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}
export interface Box extends Size {
  x: number
  y: number
}
/** What the viewer's floating chrome occupies, measured in the page. */
export interface Chrome {
  /** Height of the top bar (close, counter, save), safe area included. */
  top: number
  /** Height of the bar at the bottom (the thumbnail strip, the safe area). */
  bottom: number
  /** Margin kept free beside a video: the bars' side padding. */
  side: number
}

// The text area may not squeeze the media below this share of the viewport.
const MIN_MEDIA_SHARE = 0.4
const MIN_MEDIA_HEIGHT = 160
// The paging buttons and the area's padding always stay in view.
const MIN_BOTTOM_AREA = 72
// What the post text may show of the body: lines of it, by the room left.
const FULL_CAPTION_ROOM = 250
const SHORT_CAPTION_ROOM = 200

/** The least height the media keeps, whatever the text below it. */
export function minMediaHeight(viewportHeight: number) {
  return Math.max(MIN_MEDIA_HEIGHT, viewportHeight * MIN_MEDIA_SHARE)
}

/**
 * The tallest the bottom may be: the strip of thumbnails and the caption
 * above it. The caption is clipped to a few lines, so this only bites in a
 * short viewport.
 */
export function bottomBudget(viewportHeight: number, top: number) {
  return Math.max(
    MIN_BOTTOM_AREA,
    Math.floor(viewportHeight - top - minMediaHeight(viewportHeight)),
  )
}

/**
 * How many lines of the post's text fit under the media: three when there
 * is room, fewer in a short viewport (a phone on its side), so the media
 * keeps its height and no line is cut through.
 */
export function captionLines(budget: number) {
  if (budget >= FULL_CAPTION_ROOM) return 3
  return budget >= SHORT_CAPTION_ROOM ? 2 : 1
}

/**
 * The padding that leaves the media a free area clear of the chrome and of
 * its own caption (`caption`, the height it takes above the bottom bar). An
 * image sits in it at its default zoom and may be zoomed over it; a video,
 * which has no zoom, also keeps clear of the sides.
 */
export function mediaInsets(
  viewport: Size,
  chrome: Chrome,
  video: boolean,
  caption = 0,
): Insets {
  const side = video ? chrome.side : 0
  return {
    top: chrome.top,
    bottom: Math.min(
      chrome.bottom + caption,
      bottomBudget(viewport.height, chrome.top),
    ),
    left: side,
    right: side,
  }
}

/**
 * Where media of a given size lands: contained in the viewport minus the
 * insets and centred there. Media is never scaled above its own size unless
 * `upscale` says so.
 */
export function fitBox(
  viewport: Size,
  insets: Insets,
  media: Size,
  upscale = false,
): Box {
  const free = {
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  }
  if (!media.width || !media.height)
    return { x: insets.left, y: insets.top, ...free }
  const scale = Math.min(
    free.width / media.width,
    free.height / media.height,
    upscale ? Infinity : 1,
  )
  const width = media.width * scale
  const height = media.height * scale
  return {
    x: insets.left + (free.width - width) / 2,
    y: insets.top + (free.height - height) / 2,
    width,
    height,
  }
}
