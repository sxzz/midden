// What the web app's query box offers for the value being typed: handles of
// the accounts the library knows (as authors or saved accounts), the
// owner's tags and folders, hashtags and link domains of saved posts. Most
// used first; at most a handful, read on a read thread like any list.
import { sql } from 'drizzle-orm'
import { sees, type Seeing } from '#users/principal.ts'
import { foldHashtag } from './facet-values.ts'
import { fold } from './search-text.ts'
import type { Executor } from '#db/client.ts'

export const SUGGEST_KINDS = [
  'handle',
  'tag',
  'folder',
  'hashtag',
  'domain',
] as const
export type SuggestKind = (typeof SUGGEST_KINDS)[number]

export interface Suggestion {
  /** The value as the term takes it (`@alice`, `my tag`, `cats`). */
  value: string
  /** What to show beside it: a name. */
  label?: string
  /** Saved items with it. */
  count?: number
}

const LIMIT = 8
const MAX_PREFIX = 64
/** The highest code point: every text that starts with a prefix sorts below it. */
const TOP = String.fromCodePoint(0x10_ffff)
const AT = /^@/

/** Accounts whose handle starts with the prefix, those with most rows first. */
function handles(db: Executor, prefix: string): Suggestion[] {
  const line = `@${fold(prefix.replace(AT, ''))}`
  // The name column holds the handle as a line of its own: `@alice`. The
  // trigram index finds three characters or more; shorter ones read every
  // row, as a short search does.
  const indexed = [...line].length >= 3
  const rows = db.all<{ name: string; label: string | null; count: number }>(
    sql`
    SELECT max(k.search_name) AS name, max(k.author_name) AS label,
      count(*) AS count
    FROM ${
      indexed
        ? sql`catalog_fts f CROSS JOIN catalog k ON k.id = f.rowid`
        : sql`catalog k`
    }
    WHERE ${
      indexed
        ? sql`catalog_fts MATCH ${`name : "${line.replaceAll('"', '""')}"`} AND `
        : sql``
    }instr(char(10) || k.search_name, ${`\n${line}`}) > 0
      AND k.subject_entity_id IS NOT NULL
    GROUP BY k.subject_entity_id
    ORDER BY count DESC
    LIMIT ${LIMIT * 2}`,
  )
  const out = new Map<string, Suggestion>()
  for (const row of rows) {
    if (out.size >= LIMIT) break
    const handle = row.name.split('\n').find((l) => l.startsWith(line))
    if (!handle || out.has(handle)) continue
    out.set(handle, {
      value: handle,
      ...(row.label ? { label: row.label } : {}),
      count: row.count,
    })
  }
  return [...out.values()]
}

/** The authors with the most saved posts, for a handle not begun yet. */
function topAuthors(db: Executor): Suggestion[] {
  return db
    .all<{ name: string; label: string | null; count: number }>(
      sql`
      SELECT (SELECT search_name FROM catalog WHERE id = top.row) AS name,
        (SELECT author_name FROM catalog WHERE id = top.row) AS label,
        top.count
      FROM (
        SELECT max(id) AS row, count(*) AS count FROM catalog
        WHERE author_entity_id IS NOT NULL
        GROUP BY author_entity_id ORDER BY count DESC LIMIT ${LIMIT}
      ) top`,
    )
    .flatMap((row) => {
      const handle = row.name.split('\n').find((l) => l.startsWith('@'))
      return handle
        ? [
            {
              value: handle,
              ...(row.label ? { label: row.label } : {}),
              count: row.count,
            },
          ]
        : []
    })
}

/** Values of a facet table that start with the prefix, most used first. */
function facetValues(
  db: Executor,
  table: 'post_hashtags' | 'post_domains',
  prefix: string,
): Suggestion[] {
  return db.all<Suggestion>(sql`
    SELECT value, count(*) AS count FROM ${sql.raw(table)}
    WHERE value >= ${prefix} AND value < ${prefix + TOP}
    GROUP BY value ORDER BY count DESC, value LIMIT ${LIMIT}`)
}

/** Names that start with the prefix first, then those that hold it. */
function named<T extends { name: string }>(rows: T[], prefix: string) {
  const want = prefix.toLowerCase()
  const starts = rows.filter((r) => r.name.toLowerCase().startsWith(want))
  const holds = rows.filter(
    (r) =>
      !r.name.toLowerCase().startsWith(want) &&
      r.name.toLowerCase().includes(want),
  )
  return [...starts, ...holds].slice(0, LIMIT)
}

/**
 * Suggestions for whoever asks: a viewer has no tags, and of the folders
 * only the publicly shared ones.
 */
export function suggest(r: Seeing, kind: SuggestKind, raw = ''): Suggestion[] {
  const { db } = r
  const sight = sees(r.principal)
  const prefix = [...raw.trim()].slice(0, MAX_PREFIX).join('')
  switch (kind) {
    case 'handle':
      return prefix.replace(AT, '') ? handles(db, prefix) : topAuthors(db)
    case 'tag':
      if (!sight.tags) return []
      return named(
        db.all<{ name: string; count: number }>(sql`
          SELECT t.name, count(ct.collection_id) AS count FROM tags t
          LEFT JOIN collection_tags ct ON ct.tag_id = t.id
          GROUP BY t.id ORDER BY count DESC, t.name`),
        prefix,
      ).map((t) => ({ value: t.name, count: t.count }))
    case 'folder':
      return named(
        db.all<{ name: string }>(sql`SELECT name FROM folders f
          WHERE ${
            sight.allFolders
              ? sql`1`
              : sql`EXISTS (SELECT 1 FROM shares s
                  WHERE s.target_kind = 'folder' AND s.target_id = f.id
                    AND s.revoked_at IS NULL)`
          }
          ORDER BY name`),
        prefix,
      ).map((f) => ({ value: f.name }))
    case 'hashtag':
      return facetValues(db, 'post_hashtags', foldHashtag(prefix))
    case 'domain':
      return facetValues(db, 'post_domains', prefix.toLowerCase())
  }
}
