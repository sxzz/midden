import { sql } from 'drizzle-orm'
import type { Executor } from '#db/client.ts'

interface Target {
  id: string
  platform: string
  kind: string
  objectScope: string
  externalId: string
}

const HANDLE = 'handle:'

/**
 * The stable id the app knows for a profile saved by its handle, or '': the
 * collection a capture of it moved to (an alias), the account its own
 * newest version shows, or the one account whose newest version anywhere
 * (a follow list, a post's author) goes by that handle. The adapter may ask
 * for the account by it, which never fails the way a lookup by name can.
 */
export function knownStableId(db: Executor, target: Target): string {
  if (target.kind !== 'profile' || !target.externalId.startsWith(HANDLE))
    return ''
  const handle = target.externalId.slice(HANDLE.length)
  const known = db.get<{ id: string }>(sql`
    SELECT c.external_id AS id FROM collection_identity_aliases a
    JOIN collections c ON c.id = a.collection_id
    WHERE a.platform = ${target.platform} AND a.kind = ${target.kind}
      AND a.object_scope = ${target.objectScope}
      AND a.external_id = ${target.externalId}
      AND c.external_id NOT LIKE ${`${HANDLE}%`}
    UNION ALL
    SELECT e.external_id FROM collections c
    JOIN revision_entities re ON re.revision_id = c.current_revision
      AND re.is_root = 1
    JOIN entity_versions v ON v.id = re.entity_version_id
    JOIN entities e ON e.id = v.entity_id
    WHERE c.id = ${target.id} AND e.external_id NOT LIKE ${`${HANDLE}%`}
    LIMIT 1`)
  if (known) return known.id
  return accountByHandle(db, target.platform, target.kind, handle)
}

/**
 * The one account of this platform whose newest stored version goes by the
 * handle (in any letter case), or '' when none or several do: a handle
 * passes from one account to another, and only a single owner is sure.
 */
export function accountByHandle(
  db: Executor,
  platform: string,
  kind: string,
  handle: string,
): string {
  // Read through `entity_versions_username`: every version that went by the
  // handle, kept when it is its account's newest.
  const rows = db.all<{ id: string }>(sql`
    SELECT DISTINCT e.external_id AS id FROM entity_versions v
    JOIN entities e ON e.id = v.entity_id
    WHERE lower(v.data ->> '$.username') = ${handle.toLowerCase()}
      AND v.data ->> '$.username' IS NOT NULL
      AND e.platform = ${platform} AND e.kind = ${`${platform}.${kind}`}
      AND e.external_id NOT LIKE ${`${HANDLE}%`}
      AND NOT EXISTS (
        SELECT 1 FROM entity_versions n WHERE n.entity_id = v.entity_id
          AND (n.created_at > v.created_at
            OR (n.created_at = v.created_at AND n.id > v.id)))
    LIMIT 2`)
  return rows.length === 1 ? rows[0]!.id : ''
}
