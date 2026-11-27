// How the query language names an author most readably: `@handle`, or
// `x:@handle` where another platform's account goes by it too, when that
// term selects this account and no other (`from:` reads any handle an
// account ever had); else nothing, and the key names it. The web app's
// search box writes the author control's choices so.
import { sql } from 'drizzle-orm'
import { resolveAccounts, type Types } from '#query/compile.ts'
import { authorKey, parseAuthorKey } from './list.ts'
import type { Executor } from '#db/client.ts'

/** A handle the query language takes after `@`. */
const HANDLE = /^[\w.]{1,64}$/

/** The term for each author key that has one. */
export function authorTerms(
  db: Executor,
  types: Types,
  keys: readonly string[],
): Map<string, string> {
  const terms = new Map<string, string>()
  for (const key of new Set(keys)) {
    const id = parseAuthorKey(key)
    if (!id) continue
    // The newest version's handle (`entity_versions_newest`, one seek).
    const handle = db
      .get<{ username: string | null }>(
        sql`
        SELECT v.data ->> '$.username' AS username
        FROM entities e JOIN entity_versions v ON v.entity_id = e.id
        WHERE e.platform = ${id.platform} AND e.kind = ${id.kind}
          AND e.external_id = ${id.external}
        ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
      )
      ?.username?.toLowerCase()
    if (!handle || !HANDLE.test(handle)) continue
    for (const term of [`@${handle}`, `${id.platform}:@${handle}`]) {
      const found = resolveAccounts(db, types, term)
      if (found.length === 1 && authorKey(found[0]!) === key) {
        terms.set(key, term)
        break
      }
    }
  }
  return terms
}
