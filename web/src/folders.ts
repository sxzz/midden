// A folder (收藏夹) stores the library list's API query, the one the list
// requests, without the kind: it shows posts and accounts in tabs of their
// own. The address keeps the list's own form of it (local dates, the tab's
// entity types left out). These convert between the two.

import { defaultRelMin } from './relation-filter'

/** The list tab a query belongs to. */
export type ListTab = 'x.post' | 'x.profile'

/** What one list shows: posts or accounts. */
export type Kind = 'post' | 'profile'

export const KINDS: Kind[] = ['post', 'profile']

const PLATFORMS = ['x', 'instagram']

const KIND_TYPES: Record<Kind, string[]> = {
  post: PLATFORMS.map((p) => `${p}.post`),
  profile: PLATFORMS.map((p) => `${p}.profile`),
}

const TAB_TYPES: Record<ListTab, string> = {
  'x.post': KIND_TYPES.post.join(','),
  'x.profile': KIND_TYPES.profile.join(','),
}

export const kindOf = (type: string): Kind =>
  type.endsWith('.profile') ? 'profile' : 'post'

export const tabKind = (tab: ListTab): Kind =>
  tab === 'x.profile' ? 'profile' : 'post'

export function listTab(query: string | URLSearchParams): ListTab {
  return (new URLSearchParams(query).get('entity_type') || '')
    .split(',')
    .some((type) => type.endsWith('.profile'))
    ? 'x.profile'
    : 'x.post'
}

const typesOf = (q: URLSearchParams) =>
  (q.get('entity_type') || '').split(',').filter(Boolean)

/**
 * Entity types as a folder keeps them: only the platforms they name, each
 * with both kinds. Every platform is no filter at all.
 */
function platformTypes(types: string[]) {
  const named = PLATFORMS.filter((p) =>
    types.some((type) => type.split('.', 1)[0] === p),
  )
  return named.length === PLATFORMS.length
    ? ''
    : named.flatMap((p) => KINDS.map((kind) => `${p}.${kind}`)).join(',')
}

/**
 * The tabs a folder's list needs: the kinds with results, by the counts by
 * entity type when known, else both. With none, the list still shows one
 * kind, empty.
 */
export function folderKinds(types?: Record<string, number>): Kind[] {
  if (!types) return KINDS
  const found = KINDS.filter((kind) =>
    Object.entries(types).some(([type, n]) => n > 0 && kindOf(type) === kind),
  )
  return found.length ? found : ['post']
}

/** The browser's time zone, the one its date fields count days in. */
export const localZone = () =>
  new Intl.DateTimeFormat().resolvedOptions().timeZone

const pad = (n: number) => String(n).padStart(2, '0')

/** A local calendar day as a date input writes it. */
export function localDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A folder address that never reads as a bare one, which would show the
 * folder's saved filter: an empty filter names no entity type explicitly.
 */
export function folderAddress(raw: string) {
  const q = new URLSearchParams(raw)
  const filter = new URLSearchParams(q)
  filter.delete('layout')
  filter.delete('tab')
  if (!filter.size) q.set('entity_type', '')
  return q.toString()
}

/**
 * The list's API query for an address query: local days turned into save
 * times, a relative date given the browser's time zone, the layout and the
 * folder's tab left out. With a kind, only that kind's entity types are
 * asked for, all of them where the address names none.
 */
export function apiQuery(raw: string, kind?: Kind) {
  const q = new URLSearchParams(raw)
  q.delete('layout')
  q.delete('tab')
  const types = typesOf(q)
  if (kind) {
    const named = types.length ? types : KIND_TYPES[kind]
    const kept = named.filter((type) => kindOf(type) === kind)
    q.set('entity_type', (kept.length ? kept : named).join(','))
  } else if (!types.length) q.delete('entity_type')
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
  if (!q.get('saved_within')) q.delete('tz')
  else if (!q.get('tz')) q.set('tz', localZone())
  return q.toString()
}

const idList = (raw: string | null) => (raw ? raw.split(',') : [])

/**
 * Tag lists as the server keeps them: sets of ids in order, none both
 * wanted and excluded, and a match mode only for more than one tag.
 */
function normalizeTags(q: URLSearchParams) {
  const tag = [...new Set(idList(q.get('tag')))].toSorted()
  const notTag = [...new Set(idList(q.get('not_tag')))]
    .filter((id) => !tag.includes(id))
    .toSorted()
  for (const [key, list] of [
    ['tag', tag],
    ['not_tag', notTag],
  ] as const)
    if (list.length) q.set(key, list.join(','))
    else q.delete(key)
  if (q.get('tag_mode') !== 'all' || tag.length < 2) q.delete('tag_mode')
  return q
}

/**
 * Perspectives as the server keeps them: a set, with the default threshold
 * (two of several, else the one) left out.
 */
function normalizeRelations(q: URLSearchParams) {
  const keys = [...new Set(q.getAll('rel_of').filter(Boolean))]
  q.delete('rel_of')
  for (const key of keys) q.append('rel_of', key)
  if (keys.length && q.get('rel_min') === String(defaultRelMin(keys.length)))
    q.delete('rel_min')
  return q
}

/**
 * A query with one tag merged into another, or deleted when there is none
 * to take its place, the way the server rewrites a folder's filter.
 */
export function retagQuery(raw: string, from: string, to?: string) {
  const q = new URLSearchParams(raw)
  if (
    [q.get('tag'), q.get('not_tag')].every(
      (list) => !idList(list).includes(from),
    )
  )
    return raw
  for (const key of ['tag', 'not_tag'])
    q.set(
      key,
      idList(q.get(key))
        .flatMap((id) => (id === from ? (to ? [to] : []) : [id]))
        .join(','),
    )
  // Keys in order, as the server writes a filter again.
  const entries = [...normalizeTags(q)].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return new URLSearchParams(entries).toString()
}

/**
 * The filter a folder saves for an address query, written the way the
 * server stores it: no empty or non-filter values, keys in order, authors
 * sorted, and the kind left out, whichever tab the address shows. Equal
 * filters compare equal as strings.
 */
export function folderFilter(raw: string) {
  const q = normalizeRelations(
    normalizeTags(new URLSearchParams(apiQuery(raw))),
  )
  q.set('entity_type', platformTypes(typesOf(q)))
  const entries = [...q].filter(([key, value]) => value && key !== 'cursor')
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
  // This browser's own zone goes without saying.
  if (q.get('tz') === localZone()) q.delete('tz')
  return folderAddress(q.toString())
}

/**
 * Whether an address query shows something other than the folder's filter.
 * The layout and the tab (posts or accounts) are how the list looks, not
 * what it holds.
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
  q.delete('tab')
  for (const value of q.values()) if (value) return true
  return false
}
