// The query language in the web app: the list's `q` is a query (`docs/agent.md`
// section 6), read here with the server's own parser for instant feedback,
// and split into what the filter controls show and the rest. The search box
// shows both as one query; the address keeps the controls' part as their
// parameters and the rest as `q`, so a query and the controls it can be
// shown by are one list either way.
import {
  leaves,
  OWNER_LIMITS,
  parseQuery,
  printQuery,
  QueryError,
  type Leaf,
  type QueryNode,
} from '@midden/server/query'
import { queryErrorText } from './query-errors'

export { KEYS, printQuery, type QueryNode } from '@midden/server/query'

export interface ReadQuery {
  node?: QueryNode
  /** The query in canonical form. */
  parsed: string
  error?: { message: string; position: number }
}

/**
 * A query as the server reads it, with the owner's limits; why it cannot
 * be read in the app's words (`query-errors.ts`).
 */
export function readQuery(text: string): ReadQuery {
  try {
    const node = parseQuery(text, OWNER_LIMITS)
    return { ...(node ? { node } : {}), parsed: printQuery(node) }
  } catch (error) {
    if (error instanceof QueryError)
      return {
        parsed: '',
        error: {
          message: queryErrorText(error.kind, error.detail, error.message),
          position: error.position,
        },
      }
    throw error
  }
}

const conjuncts = (node: QueryNode | undefined): QueryNode[] =>
  node ? (node.type === 'and' ? node.items : [node]) : []

const leavesOf = (node: QueryNode): Leaf[] =>
  leaves(node).map(({ leaf }) => leaf)

/** Keys whose days are counted in a time zone. */
const DATED = new Set([
  'since',
  'until',
  'within',
  'saved',
  'saved-since',
  'saved-until',
])

/** Whether a query has dates: the list then needs the browser's zone. */
export function hasDates(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  const { node } = readQuery(text)
  return (
    !!node && leavesOf(node).some((l) => l.type === 'atom' && DATED.has(l.key))
  )
}

/**
 * Whether a query searches for words (and so ranks by relevance): its
 * top-level words and phrases, as the server's keyword search takes them.
 */
export function searchesWords(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  const { node, error } = readQuery(text)
  if (error) return true
  return conjuncts(node).some((n) => n.type === 'word' || n.type === 'phrase')
}

/**
 * The words a query searches for, to mark in what it finds: those of its
 * words and phrases not excluded, as typed when it does not read.
 */
export function wordsOf(text: string | null | undefined): string[] {
  if (!text?.trim()) return []
  const { node, error } = readQuery(text)
  if (error) return text.split(SPACES).filter(Boolean)
  const out: string[] = []
  const walk = (n: QueryNode) => {
    if (n.type === 'and' || n.type === 'or') n.items.forEach(walk)
    else if (n.type === 'word' || n.type === 'phrase') out.push(n.value)
  }
  if (node) walk(node)
  return out
}

/** Whether a query says more than words: what no control shows. */
export function hasTerms(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  const { node, error } = readQuery(text)
  if (error || !node) return !!error
  return conjuncts(node).some((n) => n.type !== 'word' && n.type !== 'phrase')
}

// --- The controls' part -----------------------------------------------------

/** What the filter controls hold, in the address's own terms. */
export interface Controls {
  platform: string
  tag: string[]
  tagMode: string
  notTag: string[]
  relOf: string[]
  rel: string
  /** 0 for the default. */
  relMin: number
  postType: string
  authors: string[]
  media: string[]
  visibility: string
  sensitive: string
  sourceState: string
  /** Local days, as the date fields write them. */
  from: string
  to: string
  within: string
}

/** A value that would not read back as one bare value. */
const NEEDS_QUOTES = /[\s()"]/u
export const quoteValue = (raw: string) =>
  NEEDS_QUOTES.test(raw) || !raw ? `"${raw.replaceAll('"', '""')}"` : raw

const anyOf = (terms: string[]) =>
  terms.length > 1 ? `(${terms.join(' OR ')})` : (terms[0] ?? '')

const MEDIA_TERMS: Record<string, string> = {
  image: 'has:image',
  video: 'has:video',
  text: '-has:media',
}
const POST_TYPE_TERMS: Record<string, string> = {
  post: 'is:original',
  quote: 'is:quote',
  repost: 'is:repost',
}

/** A local day `days` after this one. */
function addDays(day: string, days: number) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

/** How the box names tags and authors: by name and handle where known. */
export interface Names {
  tagName: (id: string) => string | undefined
  /** `@alice` for an author key, where that names it alone. */
  authorTerm?: (key: string) => string | undefined
}

/** The controls as query terms; tags by name, authors by handle, if known. */
export function controlTerms(
  c: Controls,
  { tagName, authorTerm }: Names,
): string[] {
  const tag = (id: string) => `tag:${quoteValue(tagName(id) ?? id)}`
  const terms: string[] = []
  if (c.platform) terms.push(`platform:${c.platform}`)
  if (c.authors.length)
    terms.push(
      anyOf(
        c.authors.toSorted().map((key) => `from:${authorTerm?.(key) ?? key}`),
      ),
    )
  if (c.media.length)
    terms.push(anyOf(c.media.map((m) => MEDIA_TERMS[m] ?? `has:${m}`)))
  if (c.postType) terms.push(POST_TYPE_TERMS[c.postType] ?? '')
  if (c.tag.length)
    if (c.tagMode === 'all') terms.push(...c.tag.map(tag))
    else terms.push(anyOf(c.tag.map(tag)))
  for (const id of c.notTag) terms.push(`-${tag(id)}`)
  if (c.rel && c.relOf.length) {
    const keys = [...new Set(c.relOf)].toSorted().join(',')
    terms.push(
      c.relMin ? `rel:${c.rel}:${c.relMin}:${keys}` : `rel:${c.rel}:${keys}`,
    )
  }
  if (c.visibility)
    terms.push(`protected:${c.visibility === 'private' ? 'yes' : 'no'}`)
  if (c.sensitive)
    terms.push(`sensitive:${c.sensitive === 'contains' ? 'yes' : 'no'}`)
  if (c.sourceState) terms.push(`state:${c.sourceState}`)
  if (c.within) terms.push(`saved:${c.within}`)
  else if (c.from && c.from === c.to) terms.push(`saved:${c.from}`)
  else {
    if (c.from) terms.push(`saved-since:${c.from}`)
    // The field names the last day; the term the day after it.
    if (c.to) terms.push(`saved-until:${addDays(c.to, 1)}`)
  }
  return terms.filter(Boolean)
}

/** The whole query the box shows: the search's own part, then the controls'. */
export function composeQuery(q: string, c: Controls, names: Names): string {
  const own = q.trim()
  const { node, error } = readQuery(own)
  // An OR binds looser than the terms after it.
  const first = !error && node?.type === 'or' ? `(${own})` : own
  return [first, ...controlTerms(c, names)].filter(Boolean).join(' ')
}

const ACCOUNT_KEY = /^[^/\s:@]+\/[^/\s]+\/[^/\s]+$/
const WITHIN = /^\d+d$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REL = /^(following|followers|mutual):(?:(\d+):)?(.+)$/

const atomOf = (n: QueryNode, key: string) =>
  n.type === 'atom' && n.key === key ? n : undefined

/**
 * Split a query into what the controls show and the rest (`q`): each
 * top-level term a control says exactly, once, goes to it. `tagId` knows
 * the tags by name or id; `authorKey` the authors by the terms the box
 * wrote for them (a key is one already).
 */
export function splitQuery(
  node: QueryNode | undefined,
  tagId: (ref: string) => string | undefined,
  authorKey: (term: string) => string | undefined = () => undefined,
): { controls: Partial<Controls>; q: string } {
  const c: Partial<Controls> = {}
  const rest: QueryNode[] = []
  const tagsAnd: string[] = []
  for (const n of conjuncts(node)) {
    const atom = n.type === 'atom' ? n : undefined
    const items = n.type === 'or' ? n.items : [n]
    const v = atom?.value ?? ''
    // Media: one kind, or several as alternatives.
    const media = items.map((i) =>
      atomOf(i, 'has')?.value === 'image'
        ? 'image'
        : atomOf(i, 'has')?.value === 'video'
          ? 'video'
          : i.type === 'not' && atomOf(i.item, 'has')?.value === 'media'
            ? 'text'
            : '',
    )
    if (
      !c.media &&
      media.every(Boolean) &&
      new Set(media).size === media.length
    ) {
      c.media = media
      continue
    }
    // Authors by key, the author control's own values, or by the handle
    // the box wrote for one.
    const authors = items.map((i) => {
      const value = atomOf(i, 'from')?.value ?? ''
      return ACCOUNT_KEY.test(value) ? value : authorKey(value)
    })
    if (!c.authors && authors.every(Boolean)) {
      c.authors = [...new Set(authors as string[])]
      continue
    }
    // Tags: all of several, or any of them, not both.
    const anyTags = items.map((i) => {
      const t = atomOf(i, 'tag')
      return t ? tagId(t.value) : undefined
    })
    if (
      n.type === 'or' &&
      !c.tag &&
      !tagsAnd.length &&
      anyTags.every(Boolean)
    ) {
      c.tag = [...new Set(anyTags as string[])]
      c.tagMode = ''
      continue
    }
    if (atom?.key === 'tag' && !c.tag && tagId(v)) {
      tagsAnd.push(tagId(v)!)
      continue
    }
    if (n.type === 'not' && atomOf(n.item, 'tag')) {
      const id = tagId((n.item as Leaf).value)
      if (id) {
        c.notTag = [...new Set([...(c.notTag ?? []), id])]
        continue
      }
    }
    if (
      atom?.key === 'platform' &&
      !c.platform &&
      ['x', 'instagram'].includes(v)
    ) {
      c.platform = v
      continue
    }
    if (atom?.key === 'is' && !c.postType) {
      c.postType = v === 'original' ? 'post' : v
      continue
    }
    if (atom?.key === 'protected' && !c.visibility) {
      c.visibility = v === 'yes' ? 'private' : 'public'
      continue
    }
    if (atom?.key === 'sensitive' && !c.sensitive) {
      c.sensitive = v === 'yes' ? 'contains' : 'not_contains'
      continue
    }
    if (atom?.key === 'state' && !c.sourceState) {
      c.sourceState = v
      continue
    }
    if (atom?.key === 'rel' && !c.rel) {
      const [, set, min, accounts] = REL.exec(v) ?? []
      const keys = accounts?.split(',') ?? []
      if (set && keys.every((k) => ACCOUNT_KEY.test(k))) {
        c.rel = set
        c.relOf = keys
        c.relMin = min ? Number(min) : 0
        continue
      }
    }
    const dated = !!(c.within || c.from || c.to)
    if (atom?.key === 'saved' && !dated) {
      if (WITHIN.test(v)) {
        c.within = v
        continue
      }
      if (DAY.test(v)) {
        c.from = v
        c.to = v
        continue
      }
    }
    if (atom?.key === 'saved-since' && !c.within && !c.from && DAY.test(v)) {
      c.from = v
      continue
    }
    if (atom?.key === 'saved-until' && !c.within && !c.to && DAY.test(v)) {
      c.to = addDays(v, -1)
      continue
    }
    rest.push(n)
  }
  if (tagsAnd.length) {
    c.tag = [...new Set(tagsAnd)]
    c.tagMode = c.tag.length > 1 ? 'all' : ''
  }
  // A tag wanted and excluded at once selects nothing; the list's own
  // filter refuses it, so the query keeps saying it.
  const both = (c.notTag ?? []).filter((id) => c.tag?.includes(id))
  if (both.length) {
    c.notTag = c.notTag!.filter((id) => !both.includes(id))
    for (const id of both)
      rest.push({
        type: 'not',
        item: { type: 'atom', key: 'tag', value: id, start: 0, end: 0 },
        start: 0,
        end: 0,
      })
  }
  const q = printQuery(
    rest.length > 1 ? { type: 'and', items: rest, start: 0, end: 0 } : rest[0],
  )
  return { controls: c, q }
}

// --- Highlighting -------------------------------------------------------------

/** A piece of a query as it is shown: what part of the grammar it is. */
export interface Token {
  text: string
  /** `key`: `from:`, `#`; `value`: what follows; `op`: OR, -, ( ) and quotes. */
  kind: 'key' | 'value' | 'op' | 'word' | 'space'
}

const OPERATOR = /^(?:OR\b|[-()])/
const SPACE_RUN = /^\s+/
const LEX =
  /(\s+)|(OR\b|[-()])|("(?:[^"]|"")*"?)|([#＃])([^\s()]*)|([a-z][a-z-]*:)("(?:[^"]|"")*"?|[^\s()]*)|([^\s()]+)/gy

/** Tokens by the shapes of the grammar, for text the parser cannot read. */
function lex(text: string): Token[] {
  const out: Token[] = []
  LEX.lastIndex = 0
  let m: RegExpExecArray | null
  while (LEX.lastIndex < text.length && (m = LEX.exec(text))) {
    if (m[1]) out.push({ text: m[1], kind: 'space' })
    else if (m[2]) out.push({ text: m[2], kind: 'op' })
    else if (m[3]) out.push({ text: m[3], kind: 'word' })
    else if (m[4]) {
      out.push({ text: m[4], kind: 'key' })
      if (m[5]) out.push({ text: m[5], kind: 'value' })
    } else if (m[6]) {
      out.push({ text: m[6], kind: 'key' })
      if (m[7]) out.push({ text: m[7], kind: 'value' })
    } else if (m[8]) out.push({ text: m[8], kind: 'word' })
  }
  if (LEX.lastIndex < text.length)
    out.push({ text: text.slice(LEX.lastIndex), kind: 'word' })
  return out
}

/**
 * A query in pieces to colour: by the parser's own terms where it reads
 * (each term's span, its key up to the colon), and by their shapes where
 * it does not (a term still being typed).
 */
export function highlight(text: string): Token[] {
  const { node, error } = readQuery(text)
  if (error || !node) return lex(text)
  const out: Token[] = []
  let at = 0
  /** What lies between terms: spaces and operators. */
  const between = (end: number) => {
    while (at < end) {
      const rest = text.slice(at, end)
      const space = SPACE_RUN.exec(rest)
      const op = OPERATOR.exec(rest)
      const piece = space?.[0] ?? op?.[0] ?? rest[0]!
      out.push({ text: piece, kind: space ? 'space' : 'op' })
      at += piece.length
    }
  }
  for (const leaf of leavesOf(node).toSorted((a, b) => a.start - b.start)) {
    between(leaf.start)
    const term = text.slice(leaf.start, leaf.end)
    switch (leaf.type) {
      case 'atom': {
        const colon = term.indexOf(':') + 1
        out.push({ text: term.slice(0, colon), kind: 'key' })
        if (term.length > colon)
          out.push({ text: term.slice(colon), kind: 'value' })

        break
      }
      case 'hashtag': {
        out.push(
          { text: term.slice(0, 1), kind: 'key' },
          { text: term.slice(1), kind: 'value' },
        )

        break
      }
      case 'phrase': {
        out.push({ text: term, kind: 'word' })

        break
      }
      default:
        out.push({ text: term, kind: 'word' })
    }
    at = leaf.end
  }
  between(text.length)
  return out
}

// --- Completion ---------------------------------------------------------------

/** Values a key takes from a short list, as the help lists them. */
export const KEY_VALUES: Partial<Record<string, string[]>> = {
  is: ['original', 'quote', 'repost'],
  has: ['image', 'video', 'media', 'link'],
  type: ['post', 'profile'],
  state: ['deleted', 'suspended'],
  sensitive: ['yes', 'no'],
  protected: ['yes', 'no'],
  platform: ['x', 'instagram'],
  lang: ['ja', 'zh', 'ko', 'en', 'es', 'fr', 'de', 'pt'],
  rel: ['following:', 'followers:', 'mutual:'],
}

/** Keys whose value is an account. */
const HANDLE_KEYS = new Set([
  'from',
  'mentions',
  'reposted-by',
  'quotes',
  'reposts',
])

/** What the term at the caret is, and what completes it. */
export interface Completing {
  /** Where the replaced text starts and ends. */
  start: number
  end: number
  /** What is written before the value (`-from:`, `#`), kept. */
  lead: string
  /** The part of the value typed so far. */
  prefix: string
  /** Where the values come from. */
  source:
    | { kind: 'keys' }
    | { kind: 'values'; values: string[] }
    | {
        kind: 'remote'
        remote: 'handle' | 'tag' | 'folder' | 'hashtag' | 'domain'
      }
}

const TERM_START = /[\s(]/
const TERM_END = /[\s)]/
const QUOTE = /"/g
const KEY_LIKE = /^[a-z-]+$/i
const SPACES = /\s+/

/**
 * The term the caret is in or right after, and what can complete it;
 * undefined when nothing can (inside a phrase, a word with no key).
 */
export function completing(
  text: string,
  caret: number,
  keys: readonly string[],
): Completing | undefined {
  const head = text.slice(0, caret)
  // In quotes: a value (`tag:"to r`) is completed, a phrase is not.
  const open = (head.match(QUOTE)?.length ?? 0) % 2 ? head.lastIndexOf('"') : -1
  if (open !== -1 && text[open - 1] !== ':') return undefined
  let start = open === -1 ? caret : open
  while (start > 0 && !TERM_START.test(text[start - 1]!)) start--
  let end = caret
  if (open === -1) while (end < text.length && !TERM_END.test(text[end]!)) end++
  else {
    const close = text.indexOf('"', caret)
    end = close === -1 ? text.length : close + 1
  }
  let term = text.slice(start, caret)
  let lead = ''
  if (term.startsWith('-')) {
    lead = '-'
    term = term.slice(1)
  }
  if (term.startsWith('#') || term.startsWith('＃'))
    return {
      start,
      end,
      lead: `${lead}#`,
      prefix: term.slice(1),
      source: { kind: 'remote', remote: 'hashtag' },
    }
  const colon = term.indexOf(':')
  if (colon === -1)
    return term &&
      KEY_LIKE.test(term) &&
      keys.some((k) => k.startsWith(term.toLowerCase()) && k !== term)
      ? { start, end, lead, prefix: term, source: { kind: 'keys' } }
      : undefined
  const key = term.slice(0, colon).toLowerCase()
  if (!keys.includes(key)) return undefined
  let value = term.slice(colon + 1)
  let keyLead = `${lead}${key}:`
  if (value.startsWith('"')) {
    keyLead += '"'
    value = value.slice(1)
  }
  if (key === 'rel') {
    // `rel:following:@a,@b`: the set, then accounts after `:` or `,`.
    const cut = Math.max(value.lastIndexOf(':'), value.lastIndexOf(','))
    if (cut === -1)
      return {
        start,
        end,
        lead: keyLead,
        prefix: value,
        source: { kind: 'values', values: KEY_VALUES.rel! },
      }
    return {
      start,
      end,
      lead: keyLead + value.slice(0, cut + 1),
      prefix: value.slice(cut + 1),
      source: { kind: 'remote', remote: 'handle' },
    }
  }
  if (HANDLE_KEYS.has(key)) {
    // `x:@al`: the platform stays, the handle is completed.
    const at = value.indexOf('@')
    return {
      start,
      end,
      lead: keyLead + (at > 0 ? value.slice(0, at) : ''),
      prefix: at > 0 ? value.slice(at) : value,
      source: { kind: 'remote', remote: 'handle' },
    }
  }
  if (key === 'tag' || key === 'folder' || key === 'domain')
    return {
      start,
      end,
      lead: keyLead,
      prefix: value,
      source: { kind: 'remote', remote: key },
    }
  const values = KEY_VALUES[key]
  return values
    ? {
        start,
        end,
        lead: keyLead,
        prefix: value,
        source: { kind: 'values', values },
      }
    : undefined
}
