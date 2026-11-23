/**
 * Observed values (counts) live at JSON pointers declared per entity type.
 * They are kept with each capture and left out of entity versions, so a
 * changed like count is not a new version.
 */

function unescape(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~')
}

function tokens(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/')) return undefined
  return pointer.slice(1).split('/').map(unescape)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Remove the values at `paths` from a copy of `data` and return them. */
export function splitMetrics(
  data: unknown,
  paths: readonly string[],
): { data: unknown; metrics: Record<string, unknown> | undefined } {
  if (!paths.length || !isObject(data)) return { data, metrics: undefined }
  const copy = structuredClone(data)
  let metrics: Record<string, unknown> | undefined
  for (const pointer of paths) {
    const parts = tokens(pointer)
    if (!parts?.length) continue
    let parent: unknown = copy
    for (const part of parts.slice(0, -1)) {
      parent = isObject(parent) ? parent[part] : undefined
    }
    const leaf = parts.at(-1)!
    if (isObject(parent) && Object.hasOwn(parent, leaf)) {
      metrics ??= {}
      metrics[pointer] = parent[leaf]
      delete parent[leaf]
    }
  }
  return { data: copy, metrics }
}

/**
 * Put observed values back into a copy of `data`, creating missing parent
 * objects but never replacing a value that is not an object.
 */
export function overlayMetrics(
  data: unknown,
  metrics: Record<string, unknown> | undefined,
): unknown {
  if (!metrics || !isObject(data)) return data
  const copy = structuredClone(data)
  for (const [pointer, value] of Object.entries(metrics)) {
    const parts = tokens(pointer)
    if (!parts?.length) continue
    let parent: Record<string, unknown> | undefined = copy
    for (const part of parts.slice(0, -1)) {
      const next: unknown = parent[part]
      if (next === undefined) parent = parent[part] = {}
      else if (isObject(next)) parent = next
      else {
        parent = undefined
        break
      }
    }
    if (parent) parent[parts.at(-1)!] = value
  }
  return copy
}
