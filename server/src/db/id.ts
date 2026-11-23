import { randomUUIDv7 } from 'node:crypto'

let last = ''

/**
 * A UUIDv7 that sorts after every id this process made before. Within one
 * millisecond `randomUUIDv7` orders by its random bits, so records created
 * in the same millisecond would list in random order.
 */
export function newId(): string {
  let id = randomUUIDv7()
  if (id <= last) {
    const next = (BigInt(`0x${last.replaceAll('-', '')}`) + 1n)
      .toString(16)
      .padStart(32, '0')
    id = `${next.slice(0, 8)}-${next.slice(8, 12)}-${next.slice(12, 16)}-${next.slice(16, 20)}-${next.slice(20)}`
  }
  last = id
  return id
}
