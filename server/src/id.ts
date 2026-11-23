import { randomBytes } from 'node:crypto'

let lastMs = 0
let sequence = 0

/**
 * A UUIDv7: time-ordered, so ties on a millisecond timestamp still sort by
 * creation within this process (rows are often ordered by `created_at, id`).
 */
export function newId(now = Date.now()): string {
  if (now <= lastMs) {
    // Same (or earlier) millisecond: bump a 12-bit counter instead of time.
    sequence = (sequence + 1) & 0xfff
    if (sequence === 0) lastMs++
    now = lastMs
  } else {
    lastMs = now
    sequence = randomBytes(2).readUInt16BE() & 0x7ff
  }
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = 0x70 | (sequence >> 8)
  bytes[7] = sequence & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isId(value: string): boolean {
  return UUID.test(value)
}
