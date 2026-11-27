// A query of the agent API's query language, read and checked: the parser
// (`grammar.peggy`) gives its shape, this gives each value its meaning and
// canonical form, and holds the query to its cost limits. What the values
// name in the archive (accounts, tags, folders) is looked up when it is
// compiled (`compile.ts`).
import { domainOf, foldHashtag } from '#library/facets.ts'
import { KEYS, type Key } from './keys.ts'
import { parse, SyntaxError as PeggySyntaxError } from './parser.generated.ts'

const ENDS_IN_OR = /\bOR\s*$/
const EMPTY_GROUP = /^\(\s*\)/

/** A query that cannot be run, with where in it the problem is. */
export class QueryError extends Error {
  override name = 'QueryError'
  /** Offset into the query, in UTF-16 code units. */
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.position = position
  }
}

export { KEYS, type Key } from './keys.ts'

interface Span {
  start: number
  end: number
}

export type QueryNode =
  | ({ type: 'and' | 'or'; items: QueryNode[] } & Span)
  | ({ type: 'not'; item: QueryNode } & Span)
  /** A bare word: the keyword search. */
  | ({ type: 'word'; value: string } & Span)
  /** Words that must appear together, in this order. */
  | ({ type: 'phrase'; value: string } & Span)
  /** `#tag`, folded. */
  | ({ type: 'hashtag'; value: string } & Span)
  /** `key:value`, the value in its canonical form. */
  | ({ type: 'atom'; key: Key; value: string } & Span)

export type Leaf = Extract<
  QueryNode,
  { type: 'word' | 'phrase' | 'hashtag' | 'atom' }
>

export interface Limits {
  atoms: number
  depth: number
  alternatives: number
  value: number
}

/** Cost limits: what one query of an agent's may ask for. */
export const LIMITS: Limits = {
  atoms: 16,
  depth: 4,
  alternatives: 8,
  value: 64,
}

/**
 * The owner's (the web app, folders): as much as the list's filter could
 * say (100 authors, 100 tags, 500 characters of search), and then some.
 */
export const OWNER_LIMITS: Limits = {
  atoms: 1024,
  depth: 16,
  alternatives: 128,
  value: 4096,
}

type Raw =
  | ({ type: 'empty' } & Span)
  | ({ type: 'and' | 'or'; items: Raw[] } & Span)
  | ({ type: 'not'; item: Raw } & Span)
  | ({ type: 'word' | 'phrase' | 'hashtag'; value: string } & Span)
  | ({ type: 'atom'; key: Key; value: string; quoted: boolean } & Span)

const runes = (text: string) => [...text].length

/**
 * Parentheses and quotes that do not close, found before the parser, which
 * would only say what it expected at the end.
 */
function checkBalance(text: string): void {
  const open: number[] = []
  let quote = -1
  // UTF-16 offsets, as `position` counts.
  for (const [i, c] of text.split('').entries()) {
    if (quote >= 0) {
      if (c === '"') quote = -1
      continue
    }
    switch (c) {
      case '"': {
        quote = i
        break
      }
      case '(': {
        open.push(i)
        break
      }
      case ')': {
        if (!open.length)
          throw new QueryError('This ) closes no parenthesis.', i)
        open.pop()

        break
      }
      // No default
    }
  }
  if (quote >= 0) throw new QueryError('This " is never closed.', quote)
  if (open.length) throw new QueryError('This ( is never closed.', open.at(-1)!)
}

function syntaxError(text: string, error: PeggySyntaxErrorShape): QueryError {
  const at = error.location?.start.offset ?? 0
  const found = error.found
  if (found === null || found === undefined)
    return new QueryError(
      `The query ends too early: ${ENDS_IN_OR.test(text) ? 'OR needs a term after it' : 'a term is missing at the end'}.`,
      at,
    )
  if (found === '-' || text.slice(at).startsWith('-'))
    return new QueryError(
      '- must be followed by a term, with no space between (-#ad, -from:@a).',
      at,
    )
  if (text.startsWith('OR', at))
    return new QueryError('OR needs a term on each side.', at)
  const empty = EMPTY_GROUP.exec(text.slice(at))
  if (empty)
    return new QueryError('Empty parentheses.', at + empty[0].length - 1)
  return new QueryError(`Unexpected ${JSON.stringify(found)}.`, at)
}

interface PeggySyntaxErrorShape {
  location?: { start: { offset: number } }
  found?: string | null
}

// --- Values -------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/
const SPAN = /^[1-9]\d{0,3}[dh]$/
const HANDLE = /^@[\w.]{1,64}$/
const PLATFORM_HANDLE = /^[a-z][\w-]*:@[\w.]{1,64}$/
const ACCOUNT_KEY = /^[^/\s]+\/[^/\s]+\/[^/\s]+$/
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
// A language, optionally with its script (`zh-Hant`), as `catalog.lang`
// stores them.
const LANG = /^([a-z]{2,3})(?:-([a-z]{4}))?$/i
const PLATFORM = /^[a-z][\w-]*$/

const choices: Partial<Record<Key, Record<string, string>>> = {
  is: { original: 'original', quote: 'quote', repost: 'repost' },
  has: { image: 'image', video: 'video', media: 'media', link: 'link' },
  state: { deleted: 'deleted', suspended: 'suspended' },
  type: { post: 'post', profile: 'profile', account: 'profile' },
  sensitive: { yes: 'yes', no: 'no', true: 'yes', false: 'no' },
  protected: { yes: 'yes', no: 'no', true: 'yes', false: 'no' },
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' })
    return true
  } catch {
    return false
  }
}

const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
const MIN = /^[1-9]\d{0,5}$/
const FOLLOW_SETS = new Set(['following', 'followers', 'mutual'])

/** A moment as RFC 3339 gives it, in UTC; undefined if it is none. */
function instant(value: string): string | undefined {
  if (!INSTANT.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

/** An account as `from:` and `rel:` take one. */
function account(value: string): string | undefined {
  const lower = value.toLowerCase()
  if (HANDLE.test(lower) || PLATFORM_HANDLE.test(lower)) return lower
  if (UUID.test(value)) return lower
  if (ACCOUNT_KEY.test(value)) return value
  return undefined
}

/** The canonical value of `key:value`, or why it is not one. */
function canonicalValue(key: Key, raw: string): string | { error: string } {
  const value = raw.trim()
  if (!value) return { error: `${key}: needs a value.` }
  switch (key) {
    case 'from':
    case 'reposted-by':
      return (
        account(value) ?? {
          error: `${key}: takes @handle, x:@handle, an account key or an account id, not ${value}.`,
        }
      )
    case 'mentions': {
      const lower = value.toLowerCase()
      return HANDLE.test(lower) || PLATFORM_HANDLE.test(lower)
        ? lower
        : { error: `mentions: takes @handle or x:@handle, not ${value}.` }
    }
    case 'quotes':
    case 'reposts':
      return UUID.test(value) ||
        HANDLE.test(value.toLowerCase()) ||
        PLATFORM_HANDLE.test(value.toLowerCase())
        ? value.toLowerCase()
        : { error: `${key}: takes a post id or @handle, not ${value}.` }
    case 'rel': {
      // `following:@a`, or several accounts and how many of them:
      // `following:2:@a,@b,@c` (at least 2; 2 of several by default).
      const [set, ...rest] = value.split(':')
      let min: string | undefined
      if (MIN.test(rest[0] ?? '') && rest.length > 1) min = rest.shift()
      const accounts = rest
        .join(':')
        .split(',')
        .map((a) => account(a.trim()))
      const error = {
        error: `rel: takes following:, followers: or mutual: and an account, as rel:following:@alice, or several and how many of them, as rel:following:2:@a,@b,@c.`,
      }
      if (!FOLLOW_SETS.has(set!) || accounts.some((a) => !a)) return error
      const all = [...new Set(accounts as string[])].toSorted()
      const least = min ? Number(min) : Math.min(2, all.length)
      if (least > all.length) return error
      return least === Math.min(2, all.length)
        ? `${set}:${all.join(',')}`
        : `${set}:${least}:${all.join(',')}`
    }
    case 'protected':
      return choose(key, value)
    case 'related':
      return UUID.test(value)
        ? value.toLowerCase()
        : { error: `related: takes the id of a saved post or account.` }
    case 'domain': {
      const domain = domainOf(value)
      return domain ?? { error: `domain: takes a domain such as x.com.` }
    }
    case 'lang': {
      const [, lang, script] = LANG.exec(value) ?? []
      if (!lang)
        return {
          error: `lang: takes a language code such as ja, zh, zh-Hant or en.`,
        }
      return script
        ? `${lang.toLowerCase()}-${script[0]!.toUpperCase()}${script.slice(1).toLowerCase()}`
        : lang.toLowerCase()
    }
    case 'platform': {
      const lower = value.toLowerCase()
      return PLATFORM.test(lower)
        ? lower
        : { error: `platform: takes x or instagram.` }
    }
    case 'since':
    case 'until':
    case 'saved-since':
    case 'saved-until':
      return validDate(value)
        ? value
        : (instant(value) ?? {
            error: `${key}: takes a date, YYYY-MM-DD, or a moment (2026-11-01T00:00:00+09:00).`,
          })
    case 'within':
      return SPAN.test(value.toLowerCase())
        ? value.toLowerCase()
        : { error: 'within: takes a number of days or hours, as 30d or 12h.' }
    case 'saved':
      return validDate(value) || SPAN.test(value.toLowerCase())
        ? value.toLowerCase()
        : {
            error:
              'saved: takes a date (YYYY-MM-DD) or a number of days or hours (7d, 12h).',
          }
    case 'tag':
    case 'folder':
      return value
    default:
      return choose(key, value)
  }
}

function choose(key: Key, value: string): string | { error: string } {
  switch (key) {
    default: {
      if (key === 'is' && value.toLowerCase() === 'reply')
        return {
          error:
            'is:reply: the archive does not record which posts are replies.',
        }
      const allowed = choices[key]!
      const found = allowed[value.toLowerCase()]
      return (
        found ?? {
          error: `${key}: takes ${[...new Set(Object.values(allowed))].join(', ')}.`,
        }
      )
    }
  }
}

/** What a hashtag holds, as `hashtagsOf` reads them from posts. */
const TAG = /^[\p{L}\p{M}\p{Nd}_\u{30FB}]+$/u

/** A word that looks like an atom whose value is missing (`from:`). */
const BARE_KEY = new RegExp(`^(${KEYS.join('|')}):$`)

// --- Reading -----------------------------------------------------------------

function build(raw: Exclude<Raw, { type: 'empty' }>): QueryNode {
  const span = { start: raw.start, end: raw.end }
  switch (raw.type) {
    case 'and':
    case 'or': {
      // `a (b c)` is `a b c`: one level, as it is printed.
      const items = raw.items.flatMap((item) => {
        const node = build(item as Exclude<Raw, { type: 'empty' }>)
        return node.type === raw.type ? node.items : [node]
      })
      return { type: raw.type, items, ...span }
    }
    case 'not': {
      const item = build(raw.item as Exclude<Raw, { type: 'empty' }>)
      // Two negations cancel.
      return item.type === 'not' ? item.item : { type: 'not', item, ...span }
    }
    case 'word': {
      const bare = BARE_KEY.exec(raw.value)
      if (bare)
        throw new QueryError(
          `${bare[1]}: needs a value, written right after the colon.`,
          raw.start,
        )
      return { type: 'word', value: raw.value, ...span }
    }
    case 'phrase':
      if (!raw.value.trim())
        throw new QueryError('An empty phrase ("").', raw.start)
      return { type: 'phrase', value: raw.value.trim(), ...span }
    case 'hashtag': {
      const value = foldHashtag(raw.value)
      if (!TAG.test(value))
        throw new QueryError(
          `#${raw.value} is not a hashtag: letters, digits and _ only.`,
          raw.start,
        )
      return { type: 'hashtag', value, ...span }
    }
    case 'atom': {
      const value = canonicalValue(raw.key, raw.value)
      if (typeof value === 'object')
        throw new QueryError(value.error, raw.start)
      return { type: 'atom', key: raw.key, value, ...span }
    }
  }
}

/** The leaves of a query, each with whether it is negated. */
export function leaves(
  node: QueryNode,
  negated = false,
): { leaf: Leaf; negated: boolean }[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return node.items.flatMap((item) => leaves(item, negated))
    case 'not':
      return leaves(node.item, !negated)
    default:
      return [{ leaf: node, negated }]
  }
}

function checkLimits(node: QueryNode, limits: Limits): void {
  const all = leaves(node)
  if (all.length > limits.atoms)
    throw new QueryError(
      `At most ${limits.atoms} terms in a query; this one has ${all.length}.`,
      all[limits.atoms]!.leaf.start,
    )
  for (const { leaf } of all)
    if (runes(leaf.value) > limits.value)
      throw new QueryError(
        `A value is at most ${limits.value} characters.`,
        leaf.start,
      )
  // Each operator (AND, OR, -) on a path is one level.
  const walk = (n: QueryNode, above: number) => {
    if (n.type !== 'and' && n.type !== 'or' && n.type !== 'not') return
    if (above + 1 > limits.depth)
      throw new QueryError(
        `Parentheses, OR and - nest at most ${limits.depth} deep.`,
        n.start,
      )
    if (n.type === 'or' && n.items.length > limits.alternatives)
      throw new QueryError(
        `At most ${limits.alternatives} alternatives in one OR.`,
        n.items[limits.alternatives]!.start,
      )
    for (const item of n.type === 'not' ? [n.item] : n.items)
      walk(item, above + 1)
  }
  walk(node, 0)
}

/**
 * Read a query: undefined when it is empty. Throws `QueryError` for one
 * that does not parse, names an unknown value or is over a limit.
 */
export function parseQuery(
  text: string,
  limits: Limits = LIMITS,
): QueryNode | undefined {
  checkBalance(text)
  let raw: Raw
  try {
    raw = parse(text, {}) as Raw
  } catch (error) {
    if (error instanceof PeggySyntaxError)
      throw syntaxError(text, error as PeggySyntaxErrorShape)
    throw error
  }
  if (raw.type === 'empty') return undefined
  const node = build(raw)
  checkLimits(node, limits)
  return node
}

/** Whether a query asks for nothing but exclusions. */
export const onlyNegative = (node: QueryNode) =>
  leaves(node).every((l) => l.negated)

/** Whether a query uses one of these keys anywhere. */
export const usesKey = (node: QueryNode, ...keys: Key[]) =>
  leaves(node).some(
    ({ leaf }) => leaf.type === 'atom' && keys.includes(leaf.key),
  )
