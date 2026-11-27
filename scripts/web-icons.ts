#!/usr/bin/env node
// Draws the web app's install icons (manifest.webmanifest) from the mark in
// web/public/favicon.svg, its light-tab colours: a dark tile, the heap's
// three bars. Run it after the mark changes and commit the PNGs:
//   node scripts/web-icons.ts
// The shapes are only rounded rectangles, so they are drawn here, 4×4
// samples a pixel, rather than with an SVG renderer the repo lacks.
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { crc32, deflateSync } from 'node:zlib'

type RGB = [number, number, number]
const TILE: RGB = [0x1e, 0x1e, 0x1e]
const HEAP: RGB = [0xf5, 0xf5, 0xf5]
/** The heap's bars on favicon.svg's 32-unit grid: x, y, width, height. */
const BARS = [
  [11, 7, 10, 4],
  [8, 14, 16, 4],
  [5, 21, 22, 4],
] as const

interface Rect {
  x: number
  y: number
  w: number
  h: number
  r: number
}
function inside(px: number, py: number, { x, y, w, h, r }: Rect) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const dx = Math.max(x + r - px, 0, px - (x + w - r))
  const dy = Math.max(y + r - py, 0, py - (y + h - r))
  return dx * dx + dy * dy <= r * r
}

/**
 * The mark at `size` pixels. `rounded` keeps the favicon's round tile
 * (transparent corners); otherwise the tile fills the square, as a
 * maskable icon must, the heap drawn at `scale` around the centre.
 */
function drawMark(size: number, { rounded = true, scale = 1 } = {}) {
  const unit = size / 32
  const tile: Rect = {
    x: 0,
    y: 0,
    w: size,
    h: size,
    r: rounded ? 7 * unit : 0,
  }
  const bars: Rect[] = BARS.map(([x, y, w, h]) => ({
    x: (16 + (x - 16) * scale) * unit,
    y: (16 + (y - 16) * scale) * unit,
    w: w * scale * unit,
    h: h * scale * unit,
    r: 2 * scale * unit,
  }))
  const SAMPLES = 4
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0
      let heap = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES
          const y = py + (sy + 0.5) / SAMPLES
          if (!inside(x, y, tile)) continue
          covered++
          if (bars.some((bar) => inside(x, y, bar))) heap++
        }
      }
      const at = (py * size + px) * 4
      // Colour within the tile; coverage of the tile as alpha.
      const mix = covered ? heap / covered : 0
      for (let c = 0; c < 3; c++)
        pixels[at + c] = Math.round(TILE[c]! + (HEAP[c]! - TILE[c]!) * mix)
      pixels[at + 3] = Math.round((covered / SAMPLES ** 2) * 255)
    }
  }
  return encodePNG(size, pixels)
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An 8-bit RGBA PNG, unfiltered. */
function encodePNG(size: number, rgba: Buffer) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++)
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

{
  const dir = new URL('../web/public/', import.meta.url)
  await writeFile(new URL('icon-192.png', dir), drawMark(192))
  await writeFile(new URL('icon-512.png', dir), drawMark(512))
  // A maskable icon is cropped to as little as the circle of 80% its size
  // in the middle: the heap shrinks to 72%, its corners well inside it.
  await writeFile(
    new URL('icon-maskable-512.png', dir),
    drawMark(512, { rounded: false, scale: 0.72 }),
  )
}
