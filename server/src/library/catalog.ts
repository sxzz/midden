import { sql, type SQL } from 'drizzle-orm'
import { AUTHORED_BY } from './entities.ts'
import { indexFacets } from './facets.ts'
import { storageOf } from './read.ts'
import { list } from './views.ts'
import type { Database, Executor } from '#db/client.ts'

/**
 * The catalog keeps, per collection, what the library list filters and sorts
 * on, so listing reads one narrow row instead of walking each collection's
 * newest revision, its entity graph and its media.
 *
 * A row depends only on its collection: the newest revision, the media of
 * the capture behind it, the collection's storage and the counts of its
 * newest capture with any. Whatever changes those must call
 * `catalogCollections` in the same transaction: finishing a capture
 * (finalize), storing accounts read from a follow list, removing media and
 * pruning raw responses. Deleting a collection cascades.
 *
 * To change what a row holds, empty the table in a migration; the server
 * refills it on start (`catalogMissing`). Columns only a few rows fill (an
 * account's counts) can be filled in place by the migration instead.
 *
 * The search columns of a post that quotes or reposts another also hold
 * that post's catalogued name and text, so cataloguing a post refreshes them
 * on the posts whose newest revision points at it. Triggers keep the search
 * index (`catalog_fts`) in step with every insert, change and delete.
 */

// Publication time when the payload has a valid one.
const PUBLISHED_AT = `CASE WHEN h.payload ->> 'published_at' GLOB '[0-9][0-9][0-9][0-9]-*'
  THEN CAST(round(unixepoch(h.payload ->> 'published_at', 'subsec') * 1000) AS INTEGER) END`

// Content media as the platform listed them, saved or not: a post whose
// images all failed to download still counts as one with images.
const content = (filter = '') => `EXISTS (
  SELECT 1 FROM assets m
  WHERE m.capture_id = h.capture_id AND m.purpose = '' ${filter})`

/**
 * An account's own count as `h.metrics` (its newest capture's) holds it:
 * keyed by the root's type and external id, then by the pointer both
 * platforms keep account counts at. Anything but a whole number >= 0 is
 * unknown. A post's metrics have no such pointer for the post itself.
 */
const accountCount = (name: 'followers' | 'following') => `(
  SELECT CASE WHEN typeof(n) = 'integer' AND n >= 0 THEN n END FROM (
    SELECT h.metrics -> (h.root_kind || '/' || h.root_external_id)
      ->> '/metadata/${name}' AS n))`

const PROFILE = `h.root_kind LIKE '%.profile'`

/**
 * What the posts the root at `revision` and `rootKey` quotes or reposts say,
 * folded: their own catalogued names and text where they are saved, else
 * the text the revision captured with the reference.
 */
const quotedSearch = (revision: string, rootKey: string) => `coalesce((
  SELECT search_fold(group_concat(coalesce(
      (SELECT quoted.search_name || ' ' || quoted.search_text FROM catalog quoted
        WHERE quoted.root_entity_id = tv.entity_id
        ORDER BY quoted.revision_at DESC, quoted.collection_id LIMIT 1),
      tv.data ->> 'text'), ' '))
  FROM entity_relations edge
  JOIN revision_entities target ON target.revision_id = edge.revision_id
    AND target.entity_key = edge.target_key
  JOIN entity_versions tv ON tv.id = target.entity_version_id
  WHERE edge.revision_id = ${revision} AND edge.source_key = ${rootKey}
    AND edge.kind IN ('quoted', 'reposted')), '')`

/**
 * Refresh the quoted text of every catalogued post whose newest revision
 * quotes or reposts the root of one of these collections, them included.
 */
function refreshQuoting(db: Executor, targets: SQL) {
  db.run(sql`
    UPDATE catalog SET search_quoted = ${sql.raw(
      quotedSearch(
        'catalog.revision_id',
        `(SELECT re.entity_key FROM revision_entities re
          WHERE re.revision_id = catalog.revision_id AND re.is_root = 1)`,
      ),
    )}
    WHERE collection_id IN (
      SELECT quoting.collection_id
      FROM json_each(${targets}) t
      JOIN catalog quoted ON quoted.collection_id = t.value
      JOIN entity_versions v ON v.entity_id = quoted.root_entity_id
      JOIN revision_entities ref ON ref.entity_version_id = v.id
        AND ref.is_root = 0
      JOIN revisions rv ON rv.id = ref.revision_id
      JOIN catalog quoting ON quoting.collection_id = rv.collection_id
        AND quoting.revision_id = rv.id
      JOIN revision_entities src ON src.revision_id = rv.id AND src.is_root = 1
      JOIN entity_relations edge ON edge.revision_id = rv.id
        AND edge.source_key = src.entity_key AND edge.target_key = ref.entity_key
        AND edge.kind IN ('quoted', 'reposted')
      WHERE quoting.root_kind NOT LIKE '%.profile')`)
}

// How an existing row's columns are updated: each index's columns
// together, the unindexed ones last. The search columns' trigger
// refreshes the search index only when one of them changed.
export const UPDATE_GROUPS = [
  ['observed_at'],
  ['published_at'],
  ['storage_bytes'],
  ['followers_count'],
  ['following_count'],
  ['root_entity_id'],
  [
    'revision_id',
    'revision_at',
    'author_entity_id',
    'author_name',
    'subject_entity_id',
  ],
  [
    'root_kind',
    'subject_protected',
    'has_media',
    'has_image',
    'has_video',
    'has_sensitive',
    'quotes',
    'search_name',
    'search_text',
    'search_quoted',
    'search_extra',
  ],
]
// In the order the query below selects them; the groups above cover each
// but `collection_id` once (list.test.ts).
export const COLUMNS = [
  'collection_id',
  'revision_id',
  'revision_at',
  'observed_at',
  'published_at',
  'storage_bytes',
  'root_entity_id',
  'root_kind',
  'author_entity_id',
  'author_name',
  'subject_entity_id',
  'subject_protected',
  'has_media',
  'has_image',
  'has_video',
  'has_sensitive',
  'quotes',
  'search_name',
  'search_text',
  'search_quoted',
  'search_extra',
  'followers_count',
  'following_count',
]

/** Bring the catalog rows of these collections up to date. */
export function catalogCollections(db: Executor, ids: readonly string[]) {
  if (!ids.length) return
  const targets = list([...new Set(ids)])
  // The rows as they should be, compared below with the stored ones. A
  // temporary table lives outside the database file and its WAL.
  db.run(
    sql.raw(
      `CREATE TEMP TABLE IF NOT EXISTS catalog_next (${COLUMNS.join(', ')})`,
    ),
  )
  db.run(sql`DELETE FROM catalog WHERE collection_id IN (
    SELECT value FROM json_each(${targets}) t
    WHERE NOT EXISTS (SELECT 1 FROM revisions r WHERE r.collection_id = t.value))`)
  db.run(sql`
    WITH heads AS (
      SELECT c.id AS collection_id, c.observed_at, r.id AS revision_id,
        r.created_at AS revision_at, r.capture_id, r.payload,
        -- An account known only from a follow list has the capture that
        -- list made, with the counts the list gave.
        (SELECT m.metrics FROM captures cp
          JOIN capture_metrics m ON m.capture_id = cp.id
          WHERE cp.collection_id = c.id AND cp.state IN ('complete', 'partial')
          ORDER BY cp.finished_at DESC, cp.id DESC LIMIT 1) AS metrics
      FROM json_each(${targets}) t
      JOIN collections c ON c.id = t.value
      JOIN revisions r ON r.id = (
        SELECT h.id FROM revisions h WHERE h.collection_id = c.id
        ORDER BY h.created_at DESC, h.id DESC LIMIT 1)
    ),
    roots AS (
      SELECT heads.*, root.entity_key AS root_key,
        root_version.entity_id AS root_entity_id, root_entity.kind AS root_kind,
        root_entity.external_id AS root_external_id,
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
    INSERT INTO temp.catalog_next (${sql.raw(COLUMNS.join(', '))})
    SELECT h.collection_id, h.revision_id, h.revision_at, h.observed_at,
      coalesce(${sql.raw(PUBLISHED_AT)}, h.observed_at),
      ${sql.raw(storageOf('h.collection_id'))},
      h.root_entity_id, h.root_kind, h.author_entity_id,
      trim(coalesce(h.payload ->> 'author_name', '')),
      coalesce(h.author_entity_id, h.root_entity_id),
      CASE json_type(coalesce(h.author_data, h.root_data), '$.metadata.protected')
        WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
      ${sql.raw(content())},
      ${sql.raw(content(`AND m.kind = 'image'`))},
      ${sql.raw(content(`AND m.kind = 'video'`))},
      ${sql.raw(content('AND m.sensitive = 1'))},
      EXISTS (SELECT 1 FROM entity_relations edge
        WHERE edge.revision_id = h.revision_id
          AND edge.source_key = h.root_key AND edge.kind = 'quoted'),
      -- An account known only from a follow list has no author name.
      search_names(coalesce(nullif(h.payload ->> 'author_name', ''),
          coalesce(h.author_data, h.root_data) ->> 'name'),
        coalesce(h.author_data, h.root_data) ->> 'username'),
      -- An account's text is its bio, which ranks with media descriptions.
      CASE WHEN ${sql.raw(PROFILE)} THEN '' ELSE search_fold(h.payload ->> 'text') END,
      CASE WHEN ${sql.raw(PROFILE)} THEN ''
        ELSE ${sql.raw(quotedSearch('h.revision_id', 'h.root_key'))} END,
      search_fold(concat_ws(' ',
        CASE WHEN ${sql.raw(PROFILE)} THEN coalesce(
          h.root_data -> 'metadata' ->> 'description', h.payload ->> 'text') END,
        (SELECT group_concat(m.alt_text, ' ') FROM assets m
          WHERE m.capture_id = h.capture_id AND m.purpose = ''
            AND m.alt_text <> ''))),
      ${sql.raw(accountCount('followers'))},
      ${sql.raw(accountCount('following'))}
    FROM h`)
  // Rows new or on another revision: their facets follow (facets.ts). An
  // unchanged capture keeps its revision and costs them nothing.
  const revised = db
    .all<{ id: string }>(
      sql`SELECT n.collection_id AS id FROM temp.catalog_next n
        LEFT JOIN catalog k ON k.collection_id = n.collection_id
        WHERE k.revision_id IS NOT n.revision_id`,
    )
    .map((row) => row.id)
  // New rows go in whole. A row already there gets only the columns that
  // changed, in groups by index: an UPDATE rewrites the entry of every index
  // on a column it sets, changed or not, and the observation time changes
  // with every capture while the rest mostly does not.
  db.run(sql`INSERT INTO catalog (${sql.raw(COLUMNS.join(', '))})
    SELECT ${sql.raw(COLUMNS.join(', '))} FROM temp.catalog_next WHERE true
    ON CONFLICT (collection_id) DO NOTHING`)
  for (const group of UPDATE_GROUPS) {
    const set = group.map((c) => `${c} = n.${c}`).join(', ')
    const mine = group.map((c) => `catalog.${c}`).join(', ')
    const next = group.map((c) => `n.${c}`).join(', ')
    db.run(
      sql.raw(`UPDATE catalog SET ${set} FROM temp.catalog_next n
        WHERE n.collection_id = catalog.collection_id
          AND (${mine}) IS NOT (${next})`),
    )
  }
  db.run(sql`DELETE FROM temp.catalog_next`)
  if (revised.length)
    indexFacets(
      db,
      db
        .all<{ id: number }>(
          sql`SELECT id FROM catalog WHERE collection_id IN (
            SELECT value FROM json_each(${list(revised)}))`,
        )
        .map((row) => row.id),
    )
  refreshQuoting(db, targets)
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
