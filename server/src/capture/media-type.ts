import type { Buffer } from 'node:buffer'

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'avc1',
  'dash',
  'M4V ',
])

function startsWith(head: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => head[index] === byte)
}

// WHATWG MIME sniffing's MP4 signature: an `ftyp` box naming an mp4 brand.
function mp4Signature(head: Buffer): boolean {
  if (head.length < 12) return false
  const size = head.readUInt32BE(0)
  if (head.length < size || size % 4 !== 0) return false
  if (head.toString('latin1', 4, 8) !== 'ftyp') return false
  if (head.toString('latin1', 8, 11) === 'mp4') return true
  for (let offset = 16; offset < size; offset += 4)
    if (head.toString('latin1', offset, offset + 3) === 'mp4') return true
  return false
}

// Common ISO base media brands that the WHATWG signature misses.
function isoMedia(head: Buffer): boolean {
  if (head.length < 16 || head.toString('latin1', 4, 8) !== 'ftyp') return false
  const size = head.readUInt32BE(0)
  return (
    size >= 16 &&
    size <= head.length &&
    size % 4 === 0 &&
    MP4_BRANDS.has(head.toString('latin1', 8, 12))
  )
}

/** The media type of a file from its first bytes (up to 512). */
export function sniffMediaType(head: Buffer): string {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png'
  if (
    head.length >= 14 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 14) === 'WEBPVP'
  )
    return 'image/webp'
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (mp4Signature(head) || isoMedia(head)) return 'video/mp4'
  return 'application/octet-stream'
}

const ACCEPTED: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
}

export function acceptsMediaType(kind: string, mime: string): boolean {
  return ACCEPTED[kind]?.includes(mime) ?? false
}
