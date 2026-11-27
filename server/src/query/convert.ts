// A list filter (the canonical query string folders kept) as a query of the
// query language, saying exactly what it said. Folders were converted with
// it (migration `folder_queries`, through the `folder_query` SQL function);
// the web's filter controls write queries with it (`GET /v1/query/from-filter`).
// Plain string work, with no database or parser, so the database client can
// register it on every connection.
import { KEYS } from './keys.ts'

/** A folder's query, its list order and the zone of its relative dates. */
export interface StoredQuery {
  query: string
  sort: string
  order: string
  tz: string
}

const KEY_PREFIX = new RegExp(`^(?:${KEYS.join('|')}):`)
const PLAIN = /^[^\s()"]+$/
const SYNTAX_START = /^[-#＃]/
const SPACES = /\s+/

/**
 * A search word as the query language reads it back as the same word: as
 * it is, or in quotes when it would read as something else (`-x`, `#x`,
 * `OR`, `from:x`, or with parentheses or quotes in it). One word in quotes
 * finds what the word alone finds.
 */
export function wordTerm(word: string): string {
  const plain =
    PLAIN.test(word) &&
    !SYNTAX_START.test(word) &&
    word !== 'OR' &&
    !KEY_PREFIX.test(word)
  return plain ? word : `"${word.replaceAll('"', '""')}"`
}

/** Alternatives: one as it is, several in parentheses with OR. */
const anyOf = (terms: string[]) =>
  terms.length === 1 ? terms[0]! : `(${terms.join(' OR ')})`

const MEDIA: Record<string, string> = {
  image: 'has:image',
  video: 'has:video',
  text: '-has:media',
}
const POST_TYPES: Record<string, string> = {
  post: 'is:original',
  quote: 'is:quote',
  repost: 'is:repost',
}

/** An RFC 3339 moment as the language writes one: in UTC. */
function moment(raw: string): string {
  const at = Date.parse(raw)
  return Number.isNaN(at) ? raw : new Date(at).toISOString()
}

/** The query that says what this list filter says. */
export function filterToQuery(filter: string): StoredQuery {
  const params = new URLSearchParams(filter)
  const get = (key: string) => params.get(key) ?? ''
  const list = (key: string) => get(key).split(',').filter(Boolean)
  const terms: string[] = []
  // The search's words keep their order: it reads them as a phrase too.
  terms.push(
    ...get('q')
      .split(SPACES)
      .filter(Boolean)
      .map((word) => wordTerm(word)),
  )
  const types = list('entity_type')
  if (types.length) {
    const kinds = new Map<string, Set<string>>()
    for (const type of types) {
      const [platform = ''] = type.split('.', 1)
      const set = kinds.get(platform) ?? new Set<string>()
      set.add(type.endsWith('.profile') ? 'profile' : 'post')
      kinds.set(platform, set)
    }
    const groups = [...kinds]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([platform, set]) =>
        set.size === 2
          ? [`platform:${platform}`]
          : [`platform:${platform}`, `type:${[...set][0]}`],
      )
    if (groups.length === 1) terms.push(...groups[0]!)
    else
      terms.push(
        anyOf(groups.map((g) => (g.length === 1 ? g[0]! : `(${g.join(' ')})`))),
      )
  }
  const media = list('media_type')
  if (media.length)
    terms.push(anyOf(media.toSorted().map((m) => MEDIA[m] ?? `has:${m}`)))
  const visibility = get('visibility')
  if (visibility)
    terms.push(`protected:${visibility === 'private' ? 'yes' : 'no'}`)
  if (get('saved_from')) terms.push(`saved-since:${moment(get('saved_from'))}`)
  if (get('saved_before'))
    terms.push(`saved-until:${moment(get('saved_before'))}`)
  if (get('saved_within')) terms.push(`saved:${get('saved_within')}`)
  const authors = params.getAll('author').filter(Boolean)
  if (authors.length)
    terms.push(anyOf(authors.toSorted().map((key) => `from:${key}`)))
  const sensitive = get('sensitive')
  if (sensitive)
    terms.push(`sensitive:${sensitive === 'contains' ? 'yes' : 'no'}`)
  const tags = list('tag')
  if (tags.length) {
    const named = tags.map((id) => `tag:${id}`)
    if (get('tag_mode') === 'all') terms.push(...named)
    else terms.push(anyOf(named))
  }
  for (const id of list('not_tag')) terms.push(`-tag:${id}`)
  if (get('related_to')) terms.push(`related:${get('related_to')}`)
  if (get('post_type'))
    terms.push(POST_TYPES[get('post_type')] ?? `is:${get('post_type')}`)
  if (get('source_state')) terms.push(`state:${get('source_state')}`)
  const relOf = [...new Set(params.getAll('rel_of').filter(Boolean))].toSorted()
  if (relOf.length && get('rel')) {
    const min = get('rel_min')
    const fallback = String(Math.min(2, relOf.length))
    terms.push(
      min && min !== fallback
        ? `rel:${get('rel')}:${min}:${relOf.join(',')}`
        : `rel:${get('rel')}:${relOf.join(',')}`,
    )
  }
  return {
    query: terms.join(' '),
    sort: get('sort'),
    order: get('order'),
    tz: get('saved_within') ? get('tz') || get('time_zone') : '',
  }
}
