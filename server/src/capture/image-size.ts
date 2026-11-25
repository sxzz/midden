import type { Buffer } from 'node:buffer'

export interface ImageSize {
  width: number
  height: number
}

/** Enough of a file's start to read the size of a WebP or a plain JPEG. */
export const HEADER_BYTES = 64 * 1024

function webp(b: Buffer): ImageSize | undefined {
  if (b.length < 30 || b.toString('ascii', 8, 12) !== 'WEBP') return
  const kind = b.toString('ascii', 12, 16)
  if (kind === 'VP8 ')
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X')
    return {
      width: b.readUIntLE(24, 3) + 1,
      height: b.readUIntLE(27, 3) + 1,
    }
}

function jpeg(b: Buffer): ImageSize | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return
  let at = 2
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at++
      continue
    }
    // Start-of-frame markers, but not DHT (C4), JPG (C8) or DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) }
    at += 2 + b.readUInt16BE(at + 2)
  }
}

/**
 * The pixel size of a thumbnail from the start of its file: the two formats
 * the thumbnailer writes. Undefined for anything else or a damaged header,
 * so ffprobe is not needed for something ffmpeg just produced.
 */
export function imageSize(header: Buffer): ImageSize | undefined {
  const size = webp(header) ?? jpeg(header)
  return size && size.width > 0 && size.height > 0 ? size : undefined
}
