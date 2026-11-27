// Test helpers for the library read side: captures run through the real
// pipeline against the fake platform.
import { Buffer } from 'node:buffer'
import { asc, eq, getColumns } from 'drizzle-orm'
import { expect } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { submit, type SubmitInput } from '#capture/submit.ts'
import { captures, catalog } from '#db/schema.ts'
import { catalogMissing } from '#library/catalog.ts'
import { FolderCountSweep } from '#library/folder-counts.ts'
import { listFolders } from '#library/folders.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, type FakeFetch } from '#testing/fake-platform.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Database } from '#db/client.ts'
import type { Entity, EntityGraph, Resource } from '#platforms/protocol.ts'

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

/**
 * A context whose media downloads return distinct JPEG bytes per path;
 * paths under /missing/ are not found.
 */
export function libraryContext(fetch: FakeFetch) {
  const handle = { current: fetch }
  const ctx = testContext({
    platforms: [fakePlatform(handle)],
    handlers: captureHandlers,
    fetch: (input) => {
      const { pathname } = new URL(String(input))
      return Promise.resolve(
        pathname.startsWith('/missing/')
          ? new Response('', { status: 404 })
          : new Response(Buffer.concat([JPEG, Buffer.from(pathname)])),
      )
    },
  })
  ctx.queue.start()
  return { ctx, handle }
}

/** Submit and wait for everything to settle; the capture as stored. */
export async function capture(
  ctx: CaptureContext,
  input: string | SubmitInput,
) {
  const job = submit(ctx, typeof input === 'string' ? { url: input } : input)
  await ctx.queue.drain()
  return ctx.db.select().from(captures).where(eq(captures.id, job.id)).get()!
}

export function entity(
  key: string,
  type: string,
  externalId: string,
  data: object = {},
  resourceIndices: number[] = [],
): Entity {
  return {
    key,
    type,
    externalId,
    dataJson: Buffer.from(JSON.stringify(data)),
    resourceIndices,
    contextOnly: key !== 'root',
  }
}

/** A graph rooted at `root`, with [source, type, target] relations. */
export function graph(
  entities: Entity[],
  ...relations: [string, string, string][]
): EntityGraph {
  return {
    root: 'root',
    entities,
    relations: relations.map(([source, type, target]) => ({
      source,
      type,
      target,
    })),
  }
}

export function image(path: string, extra: Partial<Resource> = {}): Resource {
  return {
    url: `https://m.test/${path}`,
    kind: 'image',
    immutableKey: '',
    altText: '',
    sensitive: false,
    purpose: '',
    ...extra,
  }
}

/**
 * Every token the search indexes hold, as `[table, term, rowid, column,
 * offset]`, next to what indexes built afresh from the catalog's columns
 * would.
 */
export function searchIndexes(db: Database) {
  const client = db.$client
  client.exec(`
    CREATE VIRTUAL TABLE temp.fresh_fts USING fts5(text, name, quoted, extra,
      tokenize = 'trigram', content = '', contentless_delete = 1);
    CREATE VIRTUAL TABLE temp.fresh_cjk USING fts5(text, name, quoted, extra,
      tokenize = 'unicode61 remove_diacritics 0', detail = 'column',
      content = '', contentless_delete = 1);
    INSERT INTO temp.fresh_fts (rowid, text, name, quoted, extra)
      SELECT id, search_text, search_name, search_quoted, search_extra
      FROM catalog;
    INSERT INTO temp.fresh_cjk (rowid, text, name, quoted, extra)
      SELECT id, search_words(search_text), search_words(search_name),
        search_words(search_quoted), search_words(search_extra) FROM catalog;
    CREATE VIRTUAL TABLE temp.kept_fts USING fts5vocab(main, catalog_fts, instance);
    CREATE VIRTUAL TABLE temp.kept_cjk USING fts5vocab(main, catalog_cjk, instance);
    CREATE VIRTUAL TABLE temp.fresh_fts_tokens USING fts5vocab(temp, fresh_fts, instance);
    CREATE VIRTUAL TABLE temp.fresh_cjk_tokens USING fts5vocab(temp, fresh_cjk, instance);`)
  const tokens = (...tables: string[]) =>
    tables.flatMap((table) =>
      client
        .prepare(
          `SELECT term, doc, col, offset FROM temp.${table} ORDER BY 1, 2, 3, 4`,
        )
        .all(),
    )
  const indexes = {
    kept: tokens('kept_fts', 'kept_cjk'),
    fresh: tokens('fresh_fts_tokens', 'fresh_cjk_tokens'),
  }
  client.exec(`DROP TABLE temp.kept_fts; DROP TABLE temp.kept_cjk;
    DROP TABLE temp.fresh_fts_tokens; DROP TABLE temp.fresh_cjk_tokens;
    DROP TABLE temp.fresh_fts; DROP TABLE temp.fresh_cjk;`)
  return indexes
}

/**
 * The catalog as kept up to date matches one rebuilt from scratch, and the
 * search index matches the catalog both times.
 */
export function expectCatalogFresh(ctx: CaptureContext) {
  // Ids are assigned anew when rows are.
  const { id: _, ...columns } = getColumns(catalog)
  const facets = () =>
    ctx.db.$client
      .prepare(
        ['post_hashtags', 'post_mentions', 'post_domains']
          .map(
            (
              table,
            ) => `SELECT '${table}' AS t, k.collection_id AS c, f.value AS v
              FROM ${table} f JOIN catalog k ON k.id = f.catalog_id`,
          )
          .join(' UNION ALL ')
          .concat(' ORDER BY t, c, v'),
      )
      .all()
  const rows = () => ({
    rows: ctx.db
      .select(columns)
      .from(catalog)
      .orderBy(asc(catalog.collectionId))
      .all(),
    facets: facets(),
  })
  const kept = rows()
  const index = searchIndexes(ctx.db)
  expect(index.kept).toEqual(index.fresh)
  ctx.db.delete(catalog).run()
  catalogMissing(ctx.db)
  expect(rows()).toEqual(kept)
  const rebuilt = searchIndexes(ctx.db)
  expect(rebuilt.kept).toEqual(rebuilt.fresh)
}

/** The folders as listed once the worker has counted what is out of date. */
export async function countedFolders(db: Database) {
  await new FolderCountSweep(db).run()
  return listFolders(db)
}

/** One folder, counted as the worker would. */
export async function countedFolder(db: Database, id: string) {
  return (await countedFolders(db)).find((folder) => folder.id === id)!
}
