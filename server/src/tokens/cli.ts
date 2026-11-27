import { isAppError } from '#errors.ts'
import { adminId } from '#users/users.ts'
import {
  createToken,
  listTokens,
  parseExpiry,
  revokeToken,
  updateToken,
  type Permission,
  type TokenView,
} from './tokens.ts'
import { TokenUsage } from './usage.ts'
import type { Database } from '#db/client.ts'

/**
 * Where a command's output goes. `out` is data (stdout), what a script reads
 * and nothing else; `err` is for people (stderr).
 */
export interface Print {
  out: (line: string) => void
  err: (line: string) => void
}

const EXPIRES_HINT =
  '--expires: a future ISO time, 30m, 12h, 7d or never; --label: 1 to 64 characters'
/** Shortest id prefix shown; ids start with a timestamp, so shorter ones collide. */
const MIN_PREFIX = 8

/**
 * `token create`: the secret alone on stdout, so a script can capture it,
 * and what it is on stderr. Exit code 1 when the token is refused.
 */
export function tokenCreate(
  db: Database,
  options: {
    permission: Permission
    label?: string
    expires?: string
  },
  print: Print,
  now = Date.now(),
): number {
  try {
    const { token, secret } = createToken(
      db,
      {
        user: adminId(db),
        label: options.label ?? 'cli',
        permission: options.permission,
        expiresAt: parseExpiry(options.expires ?? 'never', now),
      },
      now,
    )
    print.out(secret)
    print.err(
      `${token.label} · ${options.permission} · ${token.expires_at ? `expires ${token.expires_at}` : 'never expires'}`,
    )
    return 0
  } catch (error) {
    if (!isAppError(error)) throw error
    print.err(`${error.message} (${EXPIRES_HINT})`)
    return 1
  }
}

/** A token as `token list` shows it: no secret, and only a prefix of the id. */
export interface ListedToken {
  /** The shortest prefix (at least 8 characters) no other token's id starts with. */
  id: string
  label: string
  permission: Permission
  created_at: string
  expires_at: string | null
  expired: boolean
  last_used_at: string | null
  /** Requests today (UTC). */
  requests_today: number
}

/** For each id, the shortest prefix that tells it from every other. */
function idPrefixes(ids: readonly string[]): Map<string, string> {
  const prefixes = new Map<string, string>()
  for (const id of ids) {
    let length = MIN_PREFIX
    while (
      length < id.length &&
      ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))
    )
      length++
    prefixes.set(id, id.slice(0, length))
  }
  return prefixes
}

function listed(db: Database, now: number): ListedToken[] {
  const tokens = listTokens(db, now)
  const prefixes = idPrefixes(tokens.map((t) => t.id))
  const usage = new TokenUsage({ db, now: () => now }).summaries(
    db,
    tokens.map((t) => t.id),
  )
  return tokens.map((t) => ({
    id: prefixes.get(t.id)!,
    label: t.label,
    permission: t.permission,
    created_at: t.created_at,
    expires_at: t.expires_at,
    expired: t.expired,
    last_used_at: t.last_used_at,
    requests_today: usage.get(t.id)!.today,
  }))
}

/** `2026-11-27T08:30:00.000Z` as `2026-11-27 08:30Z`. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`

/** Pad cells to their column's width; the last column is left as it is. */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((row) => [...row[i]!].length)),
  )
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * `token list`: every token, oldest first, as a table or (`json`) an array
 * of {@link ListedToken}. Secrets are not kept, so none can be printed.
 */
export function tokenList(
  db: Database,
  options: { json?: boolean },
  print: Print,
  now = Date.now(),
): number {
  const tokens = listed(db, now)
  if (options.json) {
    print.out(JSON.stringify(tokens))
    return 0
  }
  if (!tokens.length) {
    print.err('no tokens')
    return 0
  }
  for (const line of table([
    ['LABEL', 'ID', 'PERM', 'CREATED', 'EXPIRES', 'LAST USED', 'TODAY'],
    ...tokens.map((t) => [
      t.label,
      `${t.id}…`,
      t.permission,
      minute(t.created_at),
      t.expires_at
        ? `${minute(t.expires_at)}${t.expired ? ' (expired)' : ''}`
        : 'never',
      t.last_used_at ? minute(t.last_used_at) : '-',
      String(t.requests_today),
    ]),
  ]))
    print.out(line)
  return 0
}

/**
 * The tokens `ref` names: the one with that id, else those with that label,
 * else those whose id starts with it. More than one is an ambiguity the
 * caller reports.
 */
function resolve(tokens: TokenView[], ref: string): TokenView[] {
  const byId = tokens.filter((t) => t.id === ref)
  if (byId.length) return byId
  const byLabel = tokens.filter((t) => t.label === ref)
  if (byLabel.length) return byLabel
  return tokens.filter((t) => t.id.startsWith(ref))
}

/** The one token `ref` names, or why not (printed; undefined). */
function pick(
  db: Database,
  ref: string,
  print: Print,
  now: number,
): TokenView | undefined {
  const tokens = listTokens(db, now)
  const matches = resolve(tokens, ref)
  if (!matches.length) {
    print.err(`no token has the id or label ${JSON.stringify(ref)}`)
    return undefined
  }
  if (matches.length > 1) {
    const prefixes = idPrefixes(tokens.map((t) => t.id))
    print.err(
      `${matches.length} tokens match ${JSON.stringify(ref)}; use an id prefix:`,
    )
    for (const t of matches)
      print.err(
        `  ${prefixes.get(t.id)}  ${t.label}  ${t.permission}  created ${minute(t.created_at)}`,
      )
    return undefined
  }
  return matches[0]
}

/** `token revoke <id|label>`: the token and its usage are gone, at once. */
export function tokenRevoke(
  db: Database,
  ref: string,
  options: { json?: boolean },
  print: Print,
  now = Date.now(),
): number {
  const token = pick(db, ref, print, now)
  if (!token) return 1
  revokeToken(db, token.id)
  print.err(`revoked ${token.label} (${token.permission})`)
  if (options.json) print.out(JSON.stringify({ revoked: token.label }))
  return 0
}

/**
 * `token expires <id|label> <ISO time|30m|12h|7d|never>`: moves the expiry,
 * earlier or later; an expired token works again with a later one.
 */
export function tokenExpires(
  db: Database,
  ref: string,
  when: string,
  options: { json?: boolean },
  print: Print,
  now = Date.now(),
): number {
  const token = pick(db, ref, print, now)
  if (!token) return 1
  try {
    const updated = updateToken(
      db,
      token.id,
      { expiresAt: parseExpiry(when, now) },
      now,
    )
    print.err(
      `${updated.label}: ${updated.expires_at ? `expires ${updated.expires_at}` : 'never expires'}`,
    )
    if (options.json)
      print.out(
        JSON.stringify({
          label: updated.label,
          expires_at: updated.expires_at,
        }),
      )
    return 0
  } catch (error) {
    if (!isAppError(error)) throw error
    print.err(`${error.message} (${EXPIRES_HINT})`)
    return 1
  }
}
