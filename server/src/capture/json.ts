import { createHash } from 'node:crypto'

/**
 * Deterministic JSON: object keys sorted, no whitespace. Every content hash
 * is computed from this form, so equal values always hash equally.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).toSorted())
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
