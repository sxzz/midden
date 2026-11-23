import { sql } from 'drizzle-orm'
import { AUTHORED_BY } from './entities.ts'
import { storageOf } from './read.ts'
import { list } from './views.ts'
import type { Database, Executor } from '#db/client.ts'

/**
 * The catalog keeps, per collection, what the library list filters and sorts
 * on, so listing reads one narrow row instead of walking each collection's
 * newest revision, its entity graph and its media.
 *
 * A row depends only on its collection: the newest revision, the media of the
 * capture behind it and the collection's storage. Whatever changes those must
 * call `catalogCollections` in the same transaction: finishing a capture
 * (finalize) and pruning raw responses. Deleting a collection cascades.
 *
 * To change what a row holds, empty the table in a migration; the server
 * refills it on start (`catalogMissing`).
 */

// Publication time when the payload has a valid one.
const PUBLISHED_AT = `CASE WHEN h.payload ->> 'published_at' GLOB '[0-9][0-9][0-9][0-9]-*'
  THEN CAST(round(unixepoch(h.payload ->> 'published_at', 'subsec') * 1000) AS INTEGER) END`

const content = (filter = '') => `EXISTS (
  SELECT 1 FROM assets m ${filter.includes('b.') ? 'JOIN blobs b ON b.id = m.blob_id' : ''}
  WHERE m.capture_id = h.capture_id AND m.purpose = '' ${filter})`

/** Bring the catalog rows of these collections up to date. */
export function catalogCollections(db: Executor, ids: readonly string[]) {
  if (!ids.length) return
  const targets = list([...new Set(ids)])
  db.run(sql`DELETE FROM catalog WHERE collection_id IN (
    SELECT value FROM json_each(${targets}) t
    WHERE NOT EXISTS (SELECT 1 FROM revisions r WHERE r.collection_id = t.value))`)
  db.run(sql`
    WITH heads AS (
      SELECT c.id AS collection_id, c.observed_at, r.id AS revision_id,
        r.created_at AS revision_at, r.capture_id, r.payload
      FROM json_each(${targets}) t
      JOIN collections c ON c.id = t.value
      JOIN revisions r ON r.id = (
        SELECT h.id FROM revisions h WHERE h.collection_id = c.id
        ORDER BY h.created_at DESC, h.id DESC LIMIT 1)
    ),
    roots AS (
      SELECT heads.*, root.entity_key AS root_key,
        root_version.entity_id AS root_entity_id, root_entity.kind AS root_kind,
        root_version.data AS root_data
      FROM heads
      LEFT JOIN revision_entities root
        ON root.revision_id = heads.revision_id AND root.is_root = 1
      LEFT JOIN entity_versions root_version
        ON root_version.id = root.entity_version_id
      LEFT JOIN entities root_entity ON root_entity.id = root_version.entity_id
    ),
    h AS (
      SELECT roots.*, author_version.entity_id AS author_entity_id,
        author_version.data AS author_data
      FROM roots
      LEFT JOIN revision_entities author
        ON author.revision_id = roots.revision_id AND author.entity_key = (
          SELECT min(edge.target_key) FROM entity_relations edge
          WHERE edge.revision_id = roots.revision_id
            AND edge.source_key = roots.root_key AND edge.kind = ${AUTHORED_BY})
      LEFT JOIN entity_versions author_version
        ON author_version.id = author.entity_version_id
    )
    INSERT INTO catalog (collection_id, revision_id, revision_at, observed_at,
      published_at, storage_bytes, root_entity_id, root_kind, author_entity_id,
      author_name, subject_entity_id, subject_protected, has_media, has_image,
      has_video, has_sensitive, quotes, search)
    SELECT h.collection_id, h.revision_id, h.revision_at, h.observed_at,
      coalesce(${sql.raw(PUBLISHED_AT)}, h.observed_at),
      ${sql.raw(storageOf('h.collection_id'))},
      h.root_entity_id, h.root_kind, h.author_entity_id,
      trim(coalesce(h.payload ->> 'author_name', '')),
      coalesce(h.author_entity_id, h.root_entity_id),
      CASE json_type(coalesce(h.author_data, h.root_data), '$.metadata.protected')
        WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
      ${sql.raw(content())},
      ${sql.raw(content(`AND b.mime LIKE 'image/%'`))},
      ${sql.raw(content(`AND b.mime LIKE 'video/%'`))},
      ${sql.raw(content('AND m.sensitive = 1'))},
      EXISTS (SELECT 1 FROM entity_relations edge
        WHERE edge.revision_id = h.revision_id
          AND edge.source_key = h.root_key AND edge.kind = 'quoted'),
      concat_ws(' ', h.payload ->> 'text', h.payload ->> 'summary',
        h.payload ->> 'author_name')
    FROM h WHERE true
    ON CONFLICT (collection_id) DO UPDATE SET
      revision_id = excluded.revision_id,
      revision_at = excluded.revision_at,
      observed_at = excluded.observed_at,
      published_at = excluded.published_at,
      storage_bytes = excluded.storage_bytes,
      root_entity_id = excluded.root_entity_id,
      root_kind = excluded.root_kind,
      author_entity_id = excluded.author_entity_id,
      author_name = excluded.author_name,
      subject_entity_id = excluded.subject_entity_id,
      subject_protected = excluded.subject_protected,
      has_media = excluded.has_media,
      has_image = excluded.has_image,
      has_video = excluded.has_video,
      has_sensitive = excluded.has_sensitive,
      quotes = excluded.quotes,
      search = excluded.search`)
}

/**
 * Add the rows missing for collections that have a revision: after a
 * migration emptied the table, or data imported without going through
 * finalize. Returns how many were added.
 */
export function catalogMissing(db: Database, batch = 500): number {
  let added = 0
  for (;;) {
    const ids = db
      .all<{ id: string }>(
        sql`SELECT c.id FROM collections c
          WHERE NOT EXISTS (SELECT 1 FROM catalog k WHERE k.collection_id = c.id)
            AND EXISTS (SELECT 1 FROM revisions r WHERE r.collection_id = c.id)
          LIMIT ${batch}`,
      )
      .map((row) => row.id)
    if (!ids.length) return added
    db.transaction((tx) => catalogCollections(tx, ids))
    added += ids.length
  }
}
