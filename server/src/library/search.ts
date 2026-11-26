import { sql, type SQL } from 'drizzle-orm'
import { FUZZY_RATIO, parseSearch, type SearchQuery } from './search-text.ts'
import type { Executor } from '#db/client.ts'

/**
 * Library search: which catalog rows a query finds, each in a relevance
 * tier, best first:
 *
 * 1. the whole query is the author's (or account's) name or `@handle`;
 * 2. the whole query, as written, is in the names or the post's text;
 * 3. every term is somewhere: names, text, quoted posts, media
 *    descriptions or bio;
 * 4. only when the first three find fewer than `FUZZY_BELOW` rows: enough of
 *    the query's trigrams and CJK pairs are there (`FUZZY_RATIO`), so a typo
 *    or a partly matching multi-word query still finds something. The
 *    commonest units may be left out (`FUZZY_POSTINGS`).
 *
 * The indexes (`search-text.ts`) find the rows holding every term; the
 * tiers are then read from the folded columns the catalog stores, a few
 * `instr` calls per row found. Terms too short for either index (one or two
 * characters that are not CJK) are matched the same way; a query of nothing
 * but such terms reads every row's columns.
 *
 * Within a tier the list keeps the order the user chose; under 相关度
 * (`relevance`) it orders by `score`, lower first: bm25 over both indexes
 * with the columns weighted name > text > quoted > extra in the first three
 * tiers, and minus the number of matching units in the fourth.
 */

/** Below this many rows in the first three tiers, fuzzy matches join in. */
export const FUZZY_BELOW = 20

/** bm25 column weights, in the indexes' order: text, name, quoted, extra. */
const WEIGHTS = sql.raw('4.0, 8.0, 2.0, 1.0')

/** A search, as `name(rowid, tier, score)` for a `WITH` clause. */
export interface SearchHits {
  name: string
  ctes: SQL
}

const COLUMNS = ['search_name', 'search_text', 'search_quoted', 'search_extra']

/** The catalog row `k` holds the folded term in any column. */
const holds = (term: string) =>
  sql`(${sql.join(
    COLUMNS.map((c) => sql`instr(k.${sql.raw(c)}, ${term}) > 0`),
    sql` OR `,
  )})`

/** Tier 1: one of the names (or `@handle`s) of row `k` is the whole query. */
const nameIs = (folded: string) =>
  sql`(instr(char(10) || k.search_name || char(10), ${`\n${folded}\n`}) > 0
    OR instr(char(10) || k.search_name || char(10), ${`\n@${folded}\n`}) > 0)`

/** Tier 2: the names or text of row `k` hold the whole query. */
const phraseIn = (folded: string) =>
  sql`(instr(k.search_name, ${folded}) > 0 OR instr(k.search_text, ${folded}) > 0)`

/** Rows holding every term the indexes can find, with a bm25 score. */
function candidatesSQL(query: SearchQuery): SQL {
  const trigrams = query.trigrams
    ? sql`SELECT f.rowid AS rowid, bm25(f.catalog_fts, ${WEIGHTS}) AS score
        FROM catalog_fts f WHERE f.catalog_fts MATCH ${query.trigrams}`
    : undefined
  const pairs = query.words
    ? sql`SELECT p.rowid AS rowid, bm25(p.catalog_cjk, ${WEIGHTS}) AS score
        FROM catalog_cjk p WHERE p.catalog_cjk MATCH ${query.words}`
    : undefined
  if (trigrams && pairs)
    return sql`SELECT t.rowid, t.score + p.score AS score
      FROM (${trigrams}) t JOIN (${pairs}) p ON p.rowid = t.rowid`
  if (trigrams ?? pairs) return (trigrams ?? pairs)!
  // Nothing either index can find: every row is a candidate, scored by the
  // columns that hold the query.
  return sql`SELECT k.id AS rowid, -(
      8 * (instr(k.search_name, ${query.folded}) > 0)
      + 4 * (instr(k.search_text, ${query.folded}) > 0)
      + 2 * (instr(k.search_quoted, ${query.folded}) > 0)
      + (instr(k.search_extra, ${query.folded}) > 0)) AS score
    FROM catalog k`
}

/** Tiers 1 to 3. */
function strictSQL(query: SearchQuery): SQL {
  const short = query.short.map((term) => holds(term))
  return sql`
    SELECT c.rowid AS rowid,
      CASE WHEN ${nameIs(query.folded)} THEN 1
        WHEN ${phraseIn(query.folded)} THEN 2 ELSE 3 END AS tier,
      c.score AS score
    FROM (${candidatesSQL(query)}) c
    CROSS JOIN catalog k ON k.id = c.rowid
    ${short.length ? sql`WHERE ${sql.join(short, sql` AND `)}` : sql``}`
}

/** An FTS5 string: double quotes doubled. */
const quote = (text: string) => `"${text.replaceAll('"', '""')}"`

/**
 * How many index entries a fuzzy search may read. A query made of common
 * trigrams (`the`, `ion`) would read most of the index for little: the
 * commonest units are left out until the rest fit, and the share that must
 * match counts only those kept.
 */
export const FUZZY_POSTINGS = 60_000

/**
 * Tier 4: rows holding enough of the query's units, outside `strict`;
 * undefined when too few units are rare enough to tell anything.
 */
function fuzzySQL(
  db: Executor,
  fuzzy: NonNullable<SearchQuery['fuzzy']>,
  strict: string,
): SQL | undefined {
  const units = [
    ...fuzzy.trigrams.map((unit) => ({ unit, table: 'catalog_fts' })),
    ...fuzzy.pairs.map((unit) => ({ unit, table: 'catalog_cjk' })),
  ].map((u) => ({
    ...u,
    docs:
      db.get<{ doc: number }>(
        sql`SELECT doc FROM ${sql.raw(`${u.table}_terms`)} WHERE term = ${u.unit}`,
      )?.doc ?? 0,
  }))
  units.sort((a, b) => a.docs - b.docs)
  let read = 0
  const kept = units.filter((u) => (read += u.docs) <= FUZZY_POSTINGS)
  const min =
    kept.length === units.length
      ? fuzzy.min
      : Math.max(2, Math.ceil(kept.length * FUZZY_RATIO))
  // Units no row holds count against the query all the same.
  if (kept.filter((u) => u.docs).length < min || kept.length < 3)
    return undefined
  const rows = kept
    .filter((u) => u.docs)
    .map(
      ({ unit, table }) =>
        sql`SELECT t.rowid FROM ${sql.raw(table)} t WHERE t.${sql.raw(table)} MATCH ${quote(unit)}`,
    )
  return sql`
    SELECT u.rowid AS rowid, 4 AS tier, -count(*) AS score
    FROM (${sql.join(rows, sql` UNION ALL `)}) u
    WHERE u.rowid NOT IN (SELECT rowid FROM ${sql.raw(strict)})
    GROUP BY u.rowid HAVING count(*) >= ${min}`
}

/**
 * The catalog rows a query finds, as the `WITH` clause items that define
 * `name(rowid, tier, score)`; undefined when the query folds to nothing.
 */
export function searchHits(
  db: Executor,
  q: string,
  name: string,
): SearchHits | undefined {
  const query = parseSearch(q)
  if (!query) return undefined
  const strict = `${name}_strict`
  const strictCTE = sql`${sql.raw(strict)} AS MATERIALIZED (${strictSQL(query)})`
  // Whether the strict tiers find few enough is settled first, so a list
  // and its count agree on it.
  const fuzzy =
    query.fuzzy &&
    (db.get<{ n: number }>(sql`
      WITH ${strictCTE} SELECT count(*) AS n FROM ${sql.raw(strict)}`)?.n ??
      0) < FUZZY_BELOW
      ? fuzzySQL(db, query.fuzzy, strict)
      : undefined
  return {
    name,
    ctes: sql.join(
      [
        strictCTE,
        sql`${sql.raw(name)} AS MATERIALIZED (
          SELECT rowid, tier, score FROM ${sql.raw(strict)}
          ${fuzzy ? sql`UNION ALL ${fuzzy}` : sql``})`,
      ],
      sql`, `,
    ),
  }
}
