import { Buffer } from 'node:buffer'
import { hkdfSync } from 'node:crypto'

/**
 * Derive an independent key per purpose, so a leak or misuse in one place
 * (for example a signed media URL) reveals nothing about another.
 */
export function deriveKey(
  secret: string,
  purpose: string,
  length = 32,
): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, '', `midden:${purpose}`, length),
  )
}
