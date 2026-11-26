import type { Database } from '#db/client.ts'

/**
 * The search indexes and how each is built from the catalog's search
 * columns; the triggers of the `catalog_id` migration do the same per row.
 */
const INDEXES = {
  catalog_fts: `SELECT id, search_text, search_name, search_quoted, search_extra FROM catalog`,
  catalog_cjk: `SELECT id, search_words(search_text), search_words(search_name),
    search_words(search_quoted), search_words(search_extra) FROM catalog`,
} as const

export type SearchIndex = keyof typeof INDEXES
export const SEARCH_INDEXES = Object.keys(INDEXES) as SearchIndex[]

export interface SearchIndexCheck {
  index: SearchIndex
  /** Catalog rows the index has no document for. */
  missing: number
  /** Documents of the index no catalog row has. */
  extra: number
  /** FTS5's own check of the index's structure; empty when it passed. */
  error: string
}

/**
 * Whether each index holds a document for every catalog row and for no
 * other, by id, and is sound in itself. The indexes are contentless: what a
 * document holds cannot be compared with the catalog, only rebuilt from it.
 * Ids that match are what a renumbering of the catalog would break.
 */
export function checkSearchIndexes(db: Database): SearchIndexCheck[] {
  const client = db.$client
  return SEARCH_INDEXES.map((index) => {
    const row = client
      .prepare(
        `SELECT
          (SELECT count(*) FROM catalog k WHERE NOT EXISTS (
            SELECT 1 FROM ${index}_docsize d WHERE d.id = k.id)) AS missing,
          (SELECT count(*) FROM ${index}_docsize d WHERE NOT EXISTS (
            SELECT 1 FROM catalog k WHERE k.id = d.id)) AS extra`,
      )
      .get() as { missing: number; extra: number }
    let error = ''
    try {
      client.exec(`INSERT INTO ${index} (${index}) VALUES ('integrity-check')`)
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : String(error_)
    }
    return { index, missing: row.missing, extra: row.extra, error }
  })
}

export const intact = (check: SearchIndexCheck) =>
  !check.missing && !check.extra && !check.error

/** Build the indexes again from the catalog, in one transaction. */
export function rebuildSearchIndexes(db: Database): void {
  db.transaction(() => {
    for (const [index, select] of Object.entries(INDEXES))
      db.$client.exec(`
        INSERT INTO ${index} (${index}) VALUES ('delete-all');
        INSERT INTO ${index} (rowid, text, name, quoted, extra) ${select};`)
  })
}

/**
 * Merge each index into one segment: smaller, and quicker to read. Writes
 * the whole index, so only offline (`cli.ts maintain`).
 */
export function optimizeSearchIndexes(db: Database): void {
  for (const index of SEARCH_INDEXES)
    db.$client.exec(`INSERT INTO ${index} (${index}) VALUES ('optimize')`)
}
