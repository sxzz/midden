// The 「关系」 filter: an account (`rel_of`, keyed like an author) and which
// of its current follows to take (`rel`). Only the owner's lists offer it;
// a share refuses both parameters.
import type { Perspective } from './api'

export type Rel = 'following' | 'followers' | 'mutual'

export const RELS: { value: Rel; label: string }[] = [
  { value: 'following', label: '他关注的' },
  { value: 'followers', label: '关注他的' },
  { value: 'mutual', label: '互关' },
]

/** The parameters of the filter; a share's list drops them. */
export const RELATION_KEYS = ['rel_of', 'rel'] as const

export const isRel = (value: string | null): value is Rel =>
  RELS.some((rel) => rel.value === value)

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

/** The summary's words: 「@foo 关注的」, 「关注 @foo 的」, 「@foo 互关」. */
export function relationChip(rel: Rel, name: string): string {
  if (rel === 'following') return `${name} 关注的`
  if (rel === 'followers') return `关注 ${name} 的`
  return `${name} 互关`
}

/** A day as the note writes it: 11-20, with the year when not this one. */
function day(value: string, now: Date): string {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

const LIST_NAMES = { following: '关注名单', followers: '粉丝名单' } as const

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
  const lists =
    rel === 'mutual' ? (['following', 'followers'] as const) : ([rel] as const)
  return lists
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

/**
 * The library's account tab with the filter set, where a profile's follow
 * counts lead.
 */
export function relationQuery(key: string, rel: Rel) {
  return {
    entity_type: 'x.profile,instagram.profile',
    rel_of: key,
    rel,
  }
}
