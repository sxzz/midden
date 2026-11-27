import { sql } from 'drizzle-orm'
import { HANDLE, knownAccount } from './identity.ts'
import type { Executor } from '#db/client.ts'

/** How an account is named where the app lists it. */
export interface AccountName {
  /** Its display name; '' when unknown. */
  name: string
  /** Its username, without `@`; '' when unknown. */
  handle: string
}

export interface MemberAccount extends AccountName {
  /**
   * The saved collection with content to open for it: itself, or the one
   * its account is saved under (a profile saved by its handle and since
   * by its id). Absent when the library holds nothing of it.
   */
  libraryId?: string
  /** That collection's language (its bio's), for the name too. */
  lang?: string
}

interface Row {
  id: string
  platform: string
  kind: string
  objectScope: string
  externalId: string
  currentRevision: string | null
  saved: number
}

interface Named {
  name: string | null
  handle: string | null
}

const name = (row: Named | undefined): AccountName => ({
  name: row?.name ?? '',
  handle: row?.handle ?? '',
})

/**
 * Names and library links of collections listed as members of a record. A
 * profile is named by its current version, else by the newest version of
 * its account anywhere (a follow list, a post's author): a member keyed by
 * id is then shown by name, not as `x.com/i/user/<id>`. Posts get a link
 * only.
 */
export function memberAccounts(
  db: Executor,
  ids: readonly string[],
): Map<string, MemberAccount> {
  const found = new Map<string, MemberAccount>()
  if (!ids.length) return found
  const rows = db.all<Row>(sql`
    SELECT c.id, c.platform, c.kind, c.object_scope AS objectScope,
      c.external_id AS externalId, c.current_revision AS currentRevision,
      EXISTS (SELECT 1 FROM library l WHERE l.collection_id = c.id) AS saved
    FROM collections c
    WHERE c.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`)
  // The account each profile stands for: its platform and stable id.
  const accounts = new Map<string, string>()
  for (const row of rows) {
    if (row.kind !== 'profile') continue
    const account = row.externalId.startsWith(HANDLE)
      ? knownAccount(db, row.platform, row.externalId.slice(HANDLE.length))
      : row.externalId
    if (account) accounts.set(row.id, `${row.platform}/${account}`)
  }
  const keys = [...new Set(accounts.values())].map((key) => {
    const at = key.indexOf('/')
    return { key, platform: key.slice(0, at), account: key.slice(at + 1) }
  })
  // Saved collections of those accounts with content, and their names.
  const saved = new Map<string, { id: string } & Named>()
  if (keys.length)
    for (const hit of db.all<{ key: string; id: string } & Named>(sql`
      SELECT k.value ->> '$.key' AS key, c.id,
        v.data ->> '$.name' AS name, v.data ->> '$.username' AS handle
      FROM json_each(${JSON.stringify(keys)}) k
      JOIN collections c ON c.platform = k.value ->> '$.platform'
        AND c.kind = 'profile' AND c.object_scope = ''
        AND c.external_id = k.value ->> '$.account'
      JOIN library l ON l.collection_id = c.id
      JOIN revision_entities re ON re.revision_id = c.current_revision
        AND re.is_root = 1
      JOIN entity_versions v ON v.id = re.entity_version_id`))
      saved.set(hit.key, hit)
  // Own current versions, then the accounts' newest versions anywhere.
  const own = new Map(
    db
      .all<{ id: string } & Named>(
        sql`
        SELECT c.id, v.data ->> '$.name' AS name,
          v.data ->> '$.username' AS handle
        FROM collections c
        JOIN revision_entities re ON re.revision_id = c.current_revision
          AND re.is_root = 1
        JOIN entity_versions v ON v.id = re.entity_version_id
        WHERE c.kind = 'profile' AND c.id IN
          (SELECT value FROM json_each(${JSON.stringify(rows.map((r) => r.id))}))`,
      )
      .map((row) => [row.id, row]),
  )
  const unnamed = rows.filter(
    (row) => row.kind === 'profile' && !own.get(row.id)?.handle,
  )
  const entities = new Map<string, Named>()
  const wanted = [
    ...new Set(
      unnamed.flatMap((row) => {
        const key = accounts.get(row.id)
        return key && !saved.has(key) ? [key] : []
      }),
    ),
  ].map((key) => keys.find((k) => k.key === key)!)
  if (wanted.length)
    for (const hit of db.all<{ key: string } & Named>(sql`
      SELECT w.value ->> '$.key' AS key,
        (SELECT v.data ->> '$.name' FROM entity_versions v
          WHERE v.entity_id = e.id
          ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS name,
        (SELECT v.data ->> '$.username' FROM entity_versions v
          WHERE v.entity_id = e.id
          ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS handle
      FROM json_each(${JSON.stringify(wanted)}) w
      JOIN entities e ON e.platform = w.value ->> '$.platform'
        AND e.kind = (w.value ->> '$.platform') || '.profile'
        AND e.external_id = w.value ->> '$.account'`))
      entities.set(hit.key, hit)
  for (const row of rows) {
    const account = accounts.get(row.id)
    const other = account ? saved.get(account) : undefined
    const libraryId =
      row.saved && row.currentRevision ? row.id : other?.id || undefined
    const named =
      row.kind === 'profile'
        ? own.get(row.id)?.handle
          ? own.get(row.id)
          : (other ?? (account ? entities.get(account) : undefined))
        : undefined
    found.set(row.id, {
      ...name(named),
      ...(libraryId ? { libraryId } : {}),
    })
  }
  const linked = [...found.values()].flatMap((a) =>
    a.libraryId ? [a.libraryId] : [],
  )
  if (linked.length) {
    const langs = new Map(
      db
        .all<{ id: string; lang: string }>(
          sql`SELECT collection_id AS id, lang FROM catalog
            WHERE collection_id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(linked)])}))
              AND lang IS NOT NULL`,
        )
        .map((row) => [row.id, row.lang]),
    )
    for (const account of found.values()) {
      const lang = account.libraryId && langs.get(account.libraryId)
      if (lang) account.lang = lang
    }
  }
  return found
}
