// The 「关系」 filter: accounts (`rel_of`, keyed like authors, repeated),
// which of their current follows to take (`rel`), and with several, how
// many of them an account must relate to (`rel_min`, two by default). Only
// the owner's lists offer it; a share refuses all three parameters.
import type { Perspective } from './api'

export type Rel = 'following' | 'followers' | 'mutual'

export const RELS: { value: Rel; label: string }[] = [
  { value: 'following', label: '他关注的' },
  { value: 'followers', label: '关注他的' },
  { value: 'mutual', label: '互关' },
]

/** The parameters of the filter; a share's list drops them. */
export const RELATION_KEYS = ['rel_of', 'rel', 'rel_min'] as const

export const isRel = (value: string | null): value is Rel =>
  RELS.some((rel) => rel.value === value)

/** How many perspectives an account must relate to, unless said: 2 of several. */
export const defaultRelMin = (perspectives: number) =>
  Math.min(2, Math.max(1, perspectives))

/**
 * The threshold an address gives, kept within 1 and the number of
 * perspectives; the default when it gives none or nonsense.
 */
export function relMinOf(raw: string | null, perspectives: number): number {
  const value = Number(raw)
  return raw && Number.isInteger(value) && value >= 1 && value <= perspectives
    ? value
    : defaultRelMin(perspectives)
}

/**
 * An account's key, as the server writes an author's: platform, entity type
 * and the platform's id, each escaped.
 */
export function accountKey(account: { type: string; external_id: string }) {
  const platform = account.type.split('.', 1)[0] ?? ''
  return [platform, account.type, account.external_id]
    .map((part) => encodeURIComponent(part))
    .join('/')
}

/** The platform's id in a key, for an account known by nothing else. */
export function keyExternalId(key: string): string {
  try {
    return decodeURIComponent(key.split('/', 3)[2] ?? '')
  } catch {
    return ''
  }
}

/** An account as a chip names it: @handle, else its name, else its id. */
export function perspectiveName(
  key: string,
  account?: Pick<Perspective, 'name' | 'username'>,
): string {
  if (account?.username) return `@${account.username}`
  return account?.name || keyExternalId(key) || key
}

/**
 * The summary's words: 「@foo 关注的」, 「关注 @foo 的」, 「@foo 互关」; with
 * several, 「@a、@b 中至少 2 人关注的」, 「关注 @a、@b 中至少 2 人的」,
 * 「与 @a、@b 中至少 2 人互关」.
 */
export function relationChip(
  rel: Rel,
  names: string | string[],
  min = 1,
): string {
  const list = typeof names === 'string' ? [names] : names
  if (list.length === 1) {
    const name = list[0]!
    if (rel === 'following') return `${name} 关注的`
    if (rel === 'followers') return `关注 ${name} 的`
    return `${name} 互关`
  }
  const who = `${list.join('、')} 中至少 ${min} 人`
  if (rel === 'following') return `${who}关注的`
  if (rel === 'followers') return `关注 ${who}的`
  return `与 ${who}互关`
}

/** A day as the note writes it: 11-20, with the year when not this one. */
function day(value: string, now: Date): string {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

const LIST_NAMES = { following: '关注名单', followers: '粉丝名单' } as const

/** The lists a mode reads: whom they follow, who follows them, or both. */
const listsOf = (rel: Rel) =>
  rel === 'mutual' ? (['following', 'followers'] as const) : ([rel] as const)

/**
 * How far the lists behind a mode were read, e.g. 「关注名单 11-20 完整抓取 ·
 * 粉丝名单未抓取」. A list never read is only known from other accounts'
 * lists, which is what the note owns up to.
 */
export function fetchNote(
  perspective: Pick<Perspective, 'following' | 'followers'>,
  rel: Rel,
  now = new Date(),
): string {
  return listsOf(rel)
    .map((list) => {
      const name = LIST_NAMES[list]
      const fetch = perspective[list]
      if (fetch.complete_at)
        return `${name} ${day(fetch.complete_at, now)} 完整抓取`
      if (fetch.partial_at)
        return `${name} ${day(fetch.partial_at, now)} 部分抓取`
      return `${name}未抓取`
    })
    .join(' · ')
}

const SHORT_NAMES = { following: '关注', followers: '粉丝' } as const

/**
 * The same, briefly, for one of several perspectives: 「@foo 关注 11-20
 * 完整」, 「@bar 关注 11-21 部分、粉丝未抓取」.
 */
export function briefFetchNote(
  name: string,
  perspective: Pick<Perspective, 'following' | 'followers'>,
  rel: Rel,
  now = new Date(),
): string {
  const parts = listsOf(rel).map((list) => {
    const label = SHORT_NAMES[list]
    const fetch = perspective[list]
    if (fetch.complete_at) return `${label} ${day(fetch.complete_at, now)} 完整`
    if (fetch.partial_at) return `${label} ${day(fetch.partial_at, now)} 部分`
    return `${label}未抓取`
  })
  return `${name} ${parts.join('、')}`
}

/**
 * The library's account tab with the filter set, where a profile's follow
 * counts lead and a comparison sends its accounts.
 */
export function relationQuery(
  keys: string | string[],
  rel: Rel,
  min?: number,
): Record<string, string | string[]> {
  const list = typeof keys === 'string' ? [keys] : keys
  return {
    entity_type: 'x.profile,instagram.profile',
    rel_of: list.length === 1 ? list[0]! : list,
    rel,
    ...(min !== undefined && min !== defaultRelMin(list.length)
      ? { rel_min: String(min) }
      : {}),
  }
}
