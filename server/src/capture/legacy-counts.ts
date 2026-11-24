import { eq, sql } from 'drizzle-orm'
import { captures } from '#db/schema.ts'
import { tokens } from './metrics.ts'
import { metricKey, type Metrics } from './payload.ts'
import type { Database } from '#db/client.ts'
import type { Platforms } from '#platforms/registry.ts'

/**
 * Until 2026-10-15 the Go service kept counts (likes, followers, ...) inside
 * entity data, so every change of a count made a new version, and captures
 * had no metrics. The import copied both as they were: those captures' counts
 * are still in the root entity version of the revision each of them made.
 *
 * Copy them into `captures.metrics`, a batch per transaction, for the root
 * entity only and only for the capture that made the revision: a later
 * capture that reused it may have seen other counts (once counts no longer
 * made versions). A capture that already records counts for its root entity
 * is left alone, as is any value that is not a non-negative integer.
 * Returns how many captures were filled.
 */
export function fillLegacyCounts(
  db: Database,
  platforms: Platforms,
  batch = 500,
): number {
  const paths = new Map<string, string[]>()
  for (const platform of platforms.all())
    for (const type of platform.description.entityTypes)
      if (type.metricPaths.length)
        paths.set(type.name, [
          ...new Set([...(paths.get(type.name) ?? []), ...type.metricPaths]),
        ])
  // Only entities whose data still holds a count at a declared path, so once
  // filled nothing is selected again and later starts read no data.
  const holdsCount = [...paths].flatMap(([type, pointers]) =>
    pointers.flatMap((pointer) => {
      const parts = tokens(pointer)
      if (!parts?.length || parts.some((p) => p.includes('"'))) return []
      const path = `$${parts.map((p) => `."${p}"`).join('')}`
      return [
        sql`(e.kind = ${type} AND json_type(v.data, ${path}) = 'integer'
          AND json_extract(v.data, ${path}) >= 0)`,
      ]
    }),
  )
  if (!holdsCount.length) return 0

  let filled = 0
  let after = ''
  for (;;) {
    const rows = db.all<{
      id: string
      type: string
      external_id: string
      data: string
    }>(sql`
      SELECT c.id, e.kind AS type, e.external_id, v.data
      FROM captures c
      JOIN revisions r ON r.capture_id = c.id AND r.id = c.revision_id
      JOIN revision_entities re ON re.revision_id = r.id AND re.is_root = 1
      JOIN entity_versions v ON v.id = re.entity_version_id
      JOIN entities e ON e.id = v.entity_id
      WHERE c.id > ${after} AND c.state IN ('complete', 'partial')
        -- CASE, unlike AND, never reads JSON it has not checked.
        AND CASE WHEN json_valid(v.data) THEN (${sql.join(holdsCount, sql` OR `)})
          ELSE 0 END
        AND CASE
          WHEN c.metrics IS NULL THEN 1
          WHEN NOT json_valid(c.metrics) THEN 0
          WHEN json_type(c.metrics) <> 'object' THEN 0
          ELSE NOT EXISTS (SELECT 1 FROM json_each(c.metrics) m
            WHERE m.key = e.kind || '/' || e.external_id)
        END
      ORDER BY c.id
      LIMIT ${batch}`)
    if (!rows.length) return filled
    after = rows.at(-1)!.id
    db.transaction((tx) => {
      for (const row of rows) {
        const counts = readCounts(row.data, paths.get(row.type) ?? [])
        if (!counts) continue
        const current = tx
          .select({ metrics: captures.metrics })
          .from(captures)
          .where(eq(captures.id, row.id))
          .get()
        const metrics = current?.metrics as Metrics | null | undefined
        const key = metricKey(row)
        // Checked again in this transaction: never replace recorded counts.
        if (
          metrics !== null &&
          (!isObject(metrics) || Object.hasOwn(metrics, key))
        )
          continue
        tx.update(captures)
          .set({ metrics: { ...metrics, [key]: counts } })
          .where(eq(captures.id, row.id))
          .run()
        filled++
      }
    })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The non-negative integers at `pointers` in `raw`, by pointer. */
function readCounts(
  raw: string,
  pointers: readonly string[],
): Record<string, number> | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  let counts: Record<string, number> | undefined
  for (const pointer of pointers) {
    let value: unknown = data
    for (const part of tokens(pointer) ?? [])
      value = isObject(value) ? value[part] : undefined
    if (
      value !== data &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      (counts ??= {})[pointer] = value
  }
  return counts
}
