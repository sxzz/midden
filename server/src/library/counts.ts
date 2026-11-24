import { canonicalJson } from '#capture/json.ts'
import { parseFilterQuery } from './filter-query.ts'
import {
  countCollections,
  savedSince,
  type CollectionFilter,
  type FilterCounts,
  type Narrowing,
} from './list.ts'
import type { Database } from '#db/client.ts'

interface Cache {
  stamp: string
  byFilter: Map<string, FilterCounts>
}

/**
 * Counts by filter, kept while nothing writes to the database. One count
 * reads the whole library (tens of milliseconds at 60k items), so a few
 * dozen folders are counted once per change rather than on every request.
 * `total_changes()` moves with this connection's writes, `data_version`
 * with another process's (the CLI).
 */
const caches = new WeakMap<object, Cache>()

function cache(db: Database): Cache {
  const { stamp } = db.$client
    .prepare(
      `SELECT total_changes() || ':' || data_version AS stamp FROM pragma_data_version`,
    )
    .get() as { stamp: string }
  let cached = caches.get(db.$client)
  if (cached?.stamp !== stamp) {
    cached = { stamp, byFilter: new Map() }
    caches.set(db.$client, cached)
  }
  return cached
}

/**
 * The order does not change what a filter selects; the day a relative save
 * date starts on does, so a new day counts again.
 */
function countKey(canonical: string): string {
  const params = new URLSearchParams(canonical)
  params.delete('sort')
  params.delete('order')
  const within = params.get('saved_within')
  const since = within
    ? savedSince(within, params.get('time_zone') || undefined)
    : undefined
  return since === undefined ? params.toString() : `${params}#${since}`
}

/** Whether a canonical filter's counts are at hand without a query. */
export function countsCached(db: Database, canonical: string): boolean {
  return cache(db).byFilter.has(countKey(canonical))
}

/**
 * What the list shows for a query string, in total and by entity type.
 * Throws `invalid_filter` for what the list rejects.
 */
export function filterCounts(db: Database, query: string): FilterCounts {
  const { filter, canonical } = parseFilterQuery(query)
  const byFilter = cache(db).byFilter
  const key = countKey(canonical)
  let counts = byFilter.get(key)
  if (!counts) {
    counts = countCollections(db, filter)
    byFilter.set(key, counts)
  }
  return counts
}

/**
 * What a list that starts from one filter and is narrowed by another shows,
 * as a public list does, cached with the rest. Orders are left out of the
 * key and a relative save date resolved, as for a single filter.
 */
export function narrowedCounts(
  db: Database,
  base: CollectionFilter,
  narrow: Narrowing,
): FilterCounts {
  const since = base.savedWithin
    ? savedSince(base.savedWithin, base.timeZone || undefined)
    : undefined
  const key = `narrowed:${canonicalJson({
    base: { ...base, sort: undefined, order: undefined },
    narrow,
    since,
  })}`
  const byFilter = cache(db).byFilter
  let counts = byFilter.get(key)
  if (!counts) {
    counts = countCollections(db, base, narrow)
    byFilter.set(key, counts)
  }
  return counts
}
