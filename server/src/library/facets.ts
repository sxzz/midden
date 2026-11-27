// What the query language and aggregation read besides the catalog's own
// columns: per catalogued item, the hashtags, mentioned handles and link
// domains of its newest revision (`post_hashtags`, `post_mentions`,
// `post_domains`) and the language of its text (`catalog.lang`).
//
// Neither platform's stored data names hashtags, links or a language, so
// they are read from the item's own text: a post's text, an account's bio
// (and its website); the language as `lang/detect.ts` tells it. Mentions are what the platforms recorded as `mentions`
// relations of the root (X from facets and the text, Instagram from the
// caption).
//
// Writes: a row's values follow its revision, so `catalogCollections` asks
// for them again only for rows whose revision changed (or that are new), and
// only values that differ are written. Capturing an item again unchanged
// keeps its revision and writes nothing here. Rows catalogued before these
// tables are filled by maintenance (`backfillFacets`), a batch at a time
// while the worker is idle.
//
// `library_version`: folders store queries, so what one selects may depend
// on these values, and its count is kept until the version moves. Captures
// need nothing more: values change only with `catalog.revision_id`, whose
// trigger already moves the version in the same transaction. The backfill
// writes them on its own, so it moves the version once per batch that
// changed anything.
import { sql } from 'drizzle-orm'
import { detectLang } from '#lang/detect.ts'
import { readSetting } from '#settings.ts'
import { domainOf, foldHashtag } from './facet-values.ts'
import { list } from './views.ts'
import type { Database, Executor } from '#db/client.ts'

export { domainOf, foldHashtag, registrableDomain } from './facet-values.ts'

/** The tables, by what they hold. */
export const FACET_TABLES = {
  hashtags: 'post_hashtags',
  mentions: 'post_mentions',
  domains: 'post_domains',
} as const

export type FacetKind = keyof typeof FACET_TABLES

export interface Facets {
  lang: string | null
  hashtags: string[]
  mentions: string[]
  domains: string[]
}

// --- Values ---------------------------------------------------------------

const AT = /^@/

/** A handle as stored: lower case, without `@`, with its platform. */
export const mentionValue = (platform: string, handle: string) =>
  `${platform}:${handle.replace(AT, '').toLowerCase()}`

const URL_PATTERN =
  /https?:\/\/[^\s<>"'`()（）「」『』【】〈〉《》、。，！？…]+/giu
const TRAILING = /[.,;:!?'"\]}>*]+$/u

/** The links in a text, as written. */
export function linksOf(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map(([url]) =>
    url.replace(TRAILING, ''),
  )
}

// Hashtag characters as X counts them: letters, marks, digits, `_`, and the
// katakana middle dot and long vowel mark; not all digits. Not inside a word
// or right after `&` (`&#39;`), and links are removed first (`/#anchor`).
const HASHTAG = /(?<![\p{L}\p{M}\p{Nd}_&/])[#＃]([\p{L}\p{M}\p{Nd}_・]+)/gu
const HAS_LETTER = /[\p{L}\p{M}]/u

/** The hashtags of a text, folded, each once. */
export function hashtagsOf(text: string): string[] {
  const plain = text.replaceAll(URL_PATTERN, ' ')
  const tags = new Set<string>()
  for (const [, tag] of plain.matchAll(HASHTAG))
    if (HAS_LETTER.test(tag!)) tags.add(foldHashtag(tag!))
  return [...tags]
}

/** The domains a text's links (and any further addresses) point at. */
export function domainsOf(text: string, also: string[] = []): string[] {
  const domains = new Set<string>()
  for (const link of [...linksOf(text), ...also]) {
    const domain = domainOf(link)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

// --- Reading and writing --------------------------------------------------

const HANDLE_ID = /^handle:/
const NUMERIC = /^\d+$/

interface Source {
  id: number
  platform: string
  profile: number
  text: string | null
  bio: string | null
  website: string | null
  url: string | null
  lang: string | null
}

/** What each row's facets are now, read from its newest revision. */
export function facetsOf(
  db: Executor,
  ids: readonly number[],
): Map<number, Facets> {
  const out = new Map<number, Facets>()
  if (!ids.length) return out
  const rows = db.all<Source>(sql`
    SELECT k.id, c.platform, k.root_kind LIKE '%.profile' AS profile,
      r.payload ->> 'text' AS text,
      root.data -> 'metadata' ->> 'description' AS bio,
      root.data -> 'metadata' -> 'website' ->> 'url' AS website,
      root.data -> 'metadata' ->> 'url' AS url, k.lang
    FROM json_each(${list(ids)}) w
    JOIN catalog k ON k.id = w.value
    JOIN collections c ON c.id = k.collection_id
    JOIN revisions r ON r.id = k.revision_id
    LEFT JOIN revision_entities re ON re.revision_id = k.revision_id AND re.is_root = 1
    LEFT JOIN entity_versions root ON root.id = re.entity_version_id`)
  const mentions = new Map<number, Set<string>>()
  for (const row of db.all<{
    id: number
    platform: string
    username: string | null
    external: string
  }>(sql`
    SELECT k.id, target.platform, tv.data ->> 'username' AS username,
      target.external_id AS external
    FROM json_each(${list(ids)}) w
    JOIN catalog k ON k.id = w.value
    JOIN revision_entities src ON src.revision_id = k.revision_id AND src.is_root = 1
    JOIN entity_relations edge ON edge.revision_id = k.revision_id
      AND edge.source_key = src.entity_key AND edge.kind = 'mentions'
    JOIN revision_entities t ON t.revision_id = edge.revision_id
      AND t.entity_key = edge.target_key
    JOIN entity_versions tv ON tv.id = t.entity_version_id
    JOIN entities target ON target.id = tv.entity_id`)) {
    const handle =
      row.username || row.external.replace(HANDLE_ID, '').replace(NUMERIC, '')
    if (!handle) continue
    const set = mentions.get(row.id) ?? new Set<string>()
    set.add(mentionValue(row.platform, handle))
    mentions.set(row.id, set)
  }
  for (const row of rows) {
    // An account's text is its bio, as search reads it; its own address
    // on X (`metadata.url`) is no link of its.
    const text = (row.profile ? (row.bio ?? row.text) : row.text) ?? ''
    const sites = row.profile
      ? [row.website, row.platform === 'x' ? null : row.url].filter(
          (s): s is string => !!s,
        )
      : []
    out.set(row.id, {
      lang: detectLang(text).lang,
      hashtags: hashtagsOf(text),
      mentions: [...(mentions.get(row.id) ?? [])],
      domains: domainsOf(text, sites),
    })
  }
  return out
}

/**
 * Bring these catalog rows' facets up to date, writing only what differs.
 * Returns how many values (and languages) were written or removed.
 */
export function indexFacets(db: Executor, ids: readonly number[]): number {
  if (!ids.length) return 0
  const next = facetsOf(db, ids)
  let written = 0
  const langs = db.all<{ id: number; lang: string | null }>(
    sql`SELECT id, lang FROM catalog WHERE id IN (SELECT value FROM json_each(${list(ids)}))`,
  )
  for (const { id, lang } of langs) {
    const want = next.get(id)?.lang ?? null
    if (want === lang) continue
    db.run(sql`UPDATE catalog SET lang = ${want} WHERE id = ${id}`)
    written++
  }
  for (const [kind, table] of Object.entries(FACET_TABLES) as [
    FacetKind,
    string,
  ][]) {
    const stored = new Map<number, Set<string>>()
    for (const row of db.all<{ id: number; value: string }>(sql`
      SELECT catalog_id AS id, value FROM ${sql.identifier(table)}
      WHERE catalog_id IN (SELECT value FROM json_each(${list(ids)}))`)) {
      const set = stored.get(row.id) ?? new Set<string>()
      set.add(row.value)
      stored.set(row.id, set)
    }
    const drop: [number, string][] = []
    const add: [number, string][] = []
    for (const id of ids) {
      const want = new Set(next.get(id)?.[kind])
      const have = stored.get(id) ?? new Set<string>()
      for (const value of have) if (!want.has(value)) drop.push([id, value])
      for (const value of want) if (!have.has(value)) add.push([id, value])
    }
    if (drop.length)
      db.run(sql`DELETE FROM ${sql.identifier(table)}
        WHERE (catalog_id, value) IN (
          SELECT value ->> 0, value ->> 1 FROM json_each(${list(drop)}))`)
    if (add.length)
      db.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table)} (catalog_id, value)
        SELECT value ->> 0, value ->> 1 FROM json_each(${list(add)})`)
    written += drop.length + add.length
  }
  return written
}

// --- Backfill -------------------------------------------------------------

/**
 * Bumped when what is extracted changes, so the backfill goes over every
 * row again: 2 detects languages with fastText and tells simplified from
 * traditional Chinese.
 */
export const FACETS_VERSION = 2
export const BACKFILL_KEY = 'facets_backfill'

export interface BackfillState {
  version: number
  /** The highest catalog id done. */
  after: number
  done: boolean
}

export function backfillState(db: Database): BackfillState {
  try {
    const state = JSON.parse(
      readSetting(db, BACKFILL_KEY) ?? '',
    ) as BackfillState
    if (state.version === FACETS_VERSION) return state
  } catch {}
  return { version: FACETS_VERSION, after: 0, done: false }
}

/**
 * The next batch of rows catalogued before the facets existed, in one write
 * transaction with the progress it makes; false when there were none left.
 */
export function backfillBatch(db: Database, size = 500): boolean {
  return db.transaction((tx) => {
    const state = backfillState(db)
    if (state.done) return false
    const ids = tx
      .all<{ id: number }>(
        sql`SELECT id FROM catalog WHERE id > ${state.after} ORDER BY id LIMIT ${size}`,
      )
      .map((row) => row.id)
    // Folders may select by these values (`#tag`, `lang:`…), and their
    // counts are kept until `library_version` moves: a batch that wrote
    // any moves it, as a capture's new revision does.
    if (indexFacets(tx, ids))
      tx.run(sql`UPDATE library_version SET n = n + 1 WHERE id = 1`)
    const next: BackfillState = {
      version: FACETS_VERSION,
      after: ids.at(-1) ?? state.after,
      done: ids.length < size,
    }
    tx.run(sql`INSERT INTO settings (key, value) VALUES (${BACKFILL_KEY}, ${JSON.stringify(next)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    return !next.done
  })
}
