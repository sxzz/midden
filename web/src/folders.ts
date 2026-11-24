// A folder (收藏夹) stores the library list's API query, the one the list
// requests; the address keeps the list's own form of it (local dates, the
// tab's entity types left out). These convert between the two.

/** The list tab a query belongs to. */
export type ListTab = 'x.post' | 'x.profile'

const TAB_TYPES: Record<ListTab, string> = {
  'x.post': 'x.post,instagram.post',
  'x.profile': 'x.profile,instagram.profile',
}

export function listTab(query: string | URLSearchParams): ListTab {
  return (new URLSearchParams(query).get('entity_type') || '')
    .split(',')
    .some((type) => type.endsWith('.profile'))
    ? 'x.profile'
    : 'x.post'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A local calendar day as a date input writes it. */
export function localDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** An address query that names its tab's entity types, if it named none. */
export function withTab(raw: string, tab: ListTab = listTab(raw)) {
  const q = new URLSearchParams(raw)
  if (!q.get('entity_type')) q.set('entity_type', TAB_TYPES[tab])
  return q.toString()
}

/**
 * The list's API query for an address query: the tab's entity types filled
 * in, local days turned into save times, the layout left out.
 */
export function apiQuery(raw: string, tab: ListTab = listTab(raw)) {
  const q = new URLSearchParams(raw)
  q.delete('layout')
  if (!q.has('entity_type')) q.set('entity_type', TAB_TYPES[tab])
  const from = q.get('from_date')
  const to = q.get('to_date')
  q.delete('from_date')
  q.delete('to_date')
  if (from) {
    const d = new Date(`${from}T00:00:00`)
    if (Number.isFinite(d.getTime())) q.set('saved_from', d.toISOString())
  }
  if (to) {
    const d = new Date(`${to}T00:00:00`)
    if (Number.isFinite(d.getTime())) {
      d.setDate(d.getDate() + 1)
      q.set('saved_before', d.toISOString())
    }
  }
  return q.toString()
}

/**
 * The filter a folder saves for an address query, written the way the
 * server stores it: no empty or non-filter values, keys in order, authors
 * sorted. Equal filters compare equal as strings.
 */
export function folderFilter(raw: string) {
  const entries = [...new URLSearchParams(apiQuery(raw))].filter(
    ([key, value]) => value && key !== 'cursor',
  )
  entries.sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
  )
  return new URLSearchParams(entries).toString()
}

/** The address query that shows a folder's filter. */
export function folderQuery(filter: string) {
  const q = new URLSearchParams(filter)
  const from = q.get('saved_from')
  const before = q.get('saved_before')
  q.delete('saved_from')
  q.delete('saved_before')
  if (from) {
    const d = new Date(from)
    if (Number.isFinite(d.getTime())) q.set('from_date', localDay(d))
  }
  if (before) {
    const d = new Date(before)
    if (Number.isFinite(d.getTime())) {
      // The end is exclusive; the field names the last day included.
      d.setDate(d.getDate() - 1)
      q.set('to_date', localDay(d))
    }
  }
  return q.toString()
}

/**
 * Whether an address query shows something other than the folder's filter.
 * The layout is how the list looks, not what it holds.
 */
export function folderModified(raw: string, filter: string) {
  return folderFilter(raw) !== filter
}

/**
 * Whether an address query narrows or orders the library at all, which is
 * what a folder is worth saving for; the tab and the layout alone do not.
 */
export function hasFilters(raw: string) {
  const q = new URLSearchParams(raw)
  const types = q.get('entity_type')
  // One platform's entity types are a filter; the tab's own are not.
  if (types && !Object.values(TAB_TYPES).includes(types)) return true
  q.delete('entity_type')
  q.delete('layout')
  for (const value of q.values()) if (value) return true
  return false
}
