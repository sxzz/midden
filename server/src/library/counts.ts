import { canonicalJson } from '#capture/json.ts'
import { parseFilterQuery } from './filter-query.ts'
import {
  countCollections,
  countCollectionsTogether,
  savedSince,
  sharesCountPass,
  type CollectionFilter,
  type FilterCounts,
  type Narrowing,
  type QueryExtra,
} from './list.ts'
import type { Database } from '#db/client.ts'

interface Cache {
  stamp: string
  byFilter: Map<string, FilterCounts>
}

/**
 * Counts by filter, kept while the library stays as it was. One count reads
 * the whole library (tens of milliseconds at 60k items), so a few dozen
 * folders are counted once per change rather than on every request. The
 * stamp is `library_version`, which the database's triggers move with every
 * write that may change what a filter selects, from any connection; jobs,
 * downloads and observation times leave it, and the counts, alone.
 */
const caches = new WeakMap<object, Cache>()

function cache(db: Database): Cache {
  const row = db.$client
    .prepare('SELECT n FROM library_version WHERE id = 1')
    .get() as { n: number } | undefined
  const stamp = String(row?.n)
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
export function countKey(canonical: string): string {
  const params = new URLSearchParams(canonical)
  params.delete('sort')
  params.delete('order')
  const within = params.get('saved_within')
  const since = within
    ? savedSince(within, params.get('tz') || undefined)
    : undefined
  return since === undefined ? params.toString() : `${params}#${since}`
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

/** Filters counted in one pass; a pass is one stretch of blocked loop. */
const TOGETHER = 8

/**
 * `filterCounts` for several query strings. The uncached ones that test every
 * saved collection are counted together, a few to a pass (see
 * `countCollectionsTogether`), the rest one by one, with a turn for other
 * requests between passes, since each blocks the event loop.
 */
export async function filterCountsOf(
  db: Database,
  queries: readonly string[],
): Promise<FilterCounts[]> {
  const parsed = queries.map((query) => parseFilterQuery(query))
  const result = new Map<string, FilterCounts>()
  const shared = new Map<string, CollectionFilter>()
  const alone = new Map<string, CollectionFilter>()
  const byFilter = cache(db).byFilter
  for (const { filter, canonical } of parsed) {
    const key = countKey(canonical)
    const counts = byFilter.get(key)
    if (counts) result.set(key, counts)
    else if (sharesCountPass(filter)) shared.set(key, filter)
    else alone.set(key, filter)
  }
  let first = true
  const turn = async () => {
    if (!first) await new Promise((resolve) => setImmediate(resolve))
    first = false
  }
  // A write while others had their turn starts the cache over; what was
  // counted before it is only kept for this answer.
  const keep = (key: string, counts: FilterCounts) => {
    result.set(key, counts)
    cache(db).byFilter.set(key, counts)
  }
  const keys = [...shared.keys()]
  for (let at = 0; at < keys.length; at += TOGETHER) {
    await turn()
    const chunk = keys.slice(at, at + TOGETHER)
    const counted = countCollectionsTogether(
      db,
      chunk.map((key) => shared.get(key)!),
    )
    for (const [i, key] of chunk.entries()) keep(key, counted[i]!)
  }
  for (const [key, filter] of alone) {
    await turn()
    keep(key, countCollections(db, filter))
  }
  return parsed.map(({ canonical }) => result.get(countKey(canonical))!)
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
  extra?: QueryExtra,
): FilterCounts {
  // A query's relative times move with the clock: counted afresh.
  if (extra?.volatile) return countCollections(db, base, narrow, extra)
  const since = base.savedWithin
    ? savedSince(base.savedWithin, base.timeZone || undefined)
    : undefined
  const key = `narrowed:${canonicalJson({
    base: { ...base, sort: undefined, order: undefined },
    narrow,
    since,
    ...(extra ? { query: extra.key } : {}),
  })}`
  const byFilter = cache(db).byFilter
  let counts = byFilter.get(key)
  if (!counts) {
    counts = countCollections(db, base, narrow, extra)
    byFilter.set(key, counts)
  }
  return counts
}

/** What a list selects: its filter and what a query adds to it. */
export interface Selection {
  filter: CollectionFilter
  extra?: QueryExtra
}

/** A selection's counts' key: no order, its relative date resolved. */
function selectionKey({ filter, extra }: Selection): string {
  const since = filter.savedWithin
    ? savedSince(filter.savedWithin, filter.timeZone || undefined)
    : undefined
  return `query:${canonicalJson({
    filter: { ...filter, sort: undefined, order: undefined },
    since,
    ...(extra ? { query: extra.key } : {}),
  })}`
}

/**
 * What a selection holds, in total and by entity type, kept until the
 * library changes (but a query of relative times, counted afresh).
 */
export function selectionCounts(
  db: Database,
  selection: Selection,
): FilterCounts {
  if (selection.extra?.volatile)
    return countCollections(db, selection.filter, undefined, selection.extra)
  const key = selectionKey(selection)
  const byFilter = cache(db).byFilter
  let counts = byFilter.get(key)
  if (!counts) {
    counts = countCollections(db, selection.filter, undefined, selection.extra)
    byFilter.set(key, counts)
  }
  return counts
}

/**
 * `selectionCounts` for several: those of a filter alone that tests every
 * saved collection are counted together, a few to a pass, the rest one by
 * one, with a turn for other work between passes (see `filterCountsOf`).
 */
export async function selectionCountsOf(
  db: Database,
  selections: readonly Selection[],
): Promise<FilterCounts[]> {
  const result = new Map<string, FilterCounts>()
  const shared = new Map<string, CollectionFilter>()
  const alone = new Map<string, Selection>()
  const keys = selections.map((s) => selectionKey(s))
  const byFilter = cache(db).byFilter
  for (const [i, selection] of selections.entries()) {
    const key = keys[i]!
    const counts = selection.extra?.volatile ? undefined : byFilter.get(key)
    if (counts) result.set(key, counts)
    else if (!selection.extra && sharesCountPass(selection.filter))
      shared.set(key, selection.filter)
    else alone.set(key, selection)
  }
  let first = true
  const turn = async () => {
    if (!first) await new Promise((resolve) => setImmediate(resolve))
    first = false
  }
  const keep = (key: string, counts: FilterCounts, volatile?: boolean) => {
    result.set(key, counts)
    if (!volatile) cache(db).byFilter.set(key, counts)
  }
  const together = [...shared.keys()]
  for (let at = 0; at < together.length; at += TOGETHER) {
    await turn()
    const chunk = together.slice(at, at + TOGETHER)
    const counted = countCollectionsTogether(
      db,
      chunk.map((key) => shared.get(key)!),
    )
    for (const [i, key] of chunk.entries()) keep(key, counted[i]!)
  }
  for (const [key, selection] of alone) {
    await turn()
    keep(
      key,
      countCollections(db, selection.filter, undefined, selection.extra),
      selection.extra?.volatile,
    )
  }
  return keys.map((key) => result.get(key)!)
}
