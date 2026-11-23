import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { AppError } from '#errors.ts'
import { attachIncomingRelations, linkSavedEntities } from './entities.ts'
import {
  applyMetrics,
  assetsByCapture,
  captureMetrics,
  head,
  hydrate,
  iso,
  list,
  parseJson,
  type CollectionView,
  type Page,
  type Reader,
} from './views.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Metrics, Payload } from '#capture/payload.ts'

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
export const isUUID = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

/**
 * Bytes a collection keeps: its revisions, the distinct media of the
 * captures behind them, and the raw responses of its finished captures.
 * Media shared with other collections count in each.
 */
export const storageOf = (collection: string) => `(
  coalesce((SELECT sum(rv.content_bytes) FROM revisions rv
    WHERE rv.collection_id = ${collection}), 0)
  + coalesce((SELECT sum(media.size) FROM (
      SELECT DISTINCT b.hash, b.size FROM revisions rv
      JOIN assets m ON m.capture_id = rv.capture_id
      JOIN blobs b ON b.id = m.blob_id
      WHERE rv.collection_id = ${collection}) media), 0)
  + coalesce((SELECT sum(sr.size) FROM source_responses sr
    JOIN captures sc ON sc.id = sr.capture_id
    WHERE sc.collection_id = ${collection}
      AND sc.state IN ('complete', 'partial')), 0))`

export function collectionStorage(r: Reader, id: string): number {
  return (
    r.db.get<{ bytes: number }>(
      sql`SELECT ${sql.raw(storageOf('c.id'))} AS bytes FROM collections c WHERE c.id = ${id}`,
    )?.bytes ?? 0
  )
}

interface RevisionRow {
  id: string
  url: string
  external_id: string
  provider_id: string
  observed_at: number
  created_at: number
  source_state: 'deleted' | 'suspended' | null
  source_state_at: number | null
  saved_at: number | null
  revision_id: string
  revision_at: number
  payload: string
  capture_id: string
}

const REVISION_COLUMNS = `a.id, a.url, a.external_id, a.provider_id,
  a.observed_at, a.created_at, a.source_state, a.source_state_at,
  l.created_at AS saved_at, r.id AS revision_id, r.created_at AS revision_at,
  r.payload, r.capture_id`

function view(
  row: RevisionRow,
  payload: Payload,
  assets: CollectionView['assets'],
): CollectionView {
  return {
    id: row.id,
    url: row.url,
    external_id: row.external_id,
    provider_id: row.provider_id,
    revision_id: row.revision_id,
    ...hydrate(payload, assets),
    observed_at: iso(row.observed_at),
    created_at: iso(row.created_at),
    ...(row.source_state
      ? {
          source_state: row.source_state,
          ...(row.source_state_at
            ? { source_state_at: iso(row.source_state_at) }
            : {}),
        }
      : {}),
    ...(row.saved_at === null ? {} : { saved_at: iso(row.saved_at) }),
  }
}

/**
 * The head revisions of these collections, read for display: media, the
 * newest observed counts and links to saved collections. Collections
 * without a revision are left out; callers keep their own order.
 */
export function collectionsById(
  r: Reader,
  ids: readonly string[],
): Map<string, CollectionView> {
  const out = new Map<string, CollectionView>()
  if (!ids.length) return out
  const rows = r.db.all<RevisionRow & { metrics: string | null }>(sql`
    SELECT ${sql.raw(REVISION_COLUMNS)},
      (SELECT c.metrics FROM captures c
        WHERE c.collection_id = a.id AND c.metrics IS NOT NULL
          AND c.state IN ('complete', 'partial')
        ORDER BY c.finished_at DESC, c.id DESC LIMIT 1) AS metrics
    FROM collections a
    JOIN revisions r ON r.id = ${sql.raw(head('a.id'))}
    LEFT JOIN library l ON l.collection_id = a.id
    WHERE a.id IN (SELECT value FROM json_each(${list(ids)}))`)
  const media = assetsByCapture(
    r,
    rows.map((row) => row.capture_id),
  )
  for (const row of rows) {
    const collection = view(
      row,
      parseJson<Payload>(row.payload),
      media.get(row.capture_id) ?? [],
    )
    // The newest counts, even when that capture reused an older revision.
    if (row.metrics)
      applyMetrics(collection.graph, parseJson<Metrics>(row.metrics))
    out.set(row.id, collection)
  }
  linkSavedEntities(r, ...out.values())
  return out
}

function assertSaved(r: Reader, id: string): number {
  const saved = isUUID(id)
    ? r.db.get<{ at: number }>(
        sql`SELECT created_at AS at FROM library WHERE collection_id = ${id}`,
      )
    : undefined
  if (!saved) throw new AppError('not_found')
  return saved.at
}

/** A saved collection at its head revision, with everything shown on it. */
export function getCollection(ctx: CaptureContext, id: string): CollectionView {
  assertSaved(ctx, id)
  const collection = collectionsById(ctx, [id]).get(id)
  if (!collection) throw new AppError('not_found')
  attachIncomingRelations(ctx, collection)
  collection.storage_bytes = collectionStorage(ctx, id)
  return collection
}

/**
 * The revision a capture produced or reused, with the counts that capture
 * saw (or, failing that, those of the capture behind the revision).
 */
export function getCaptureCollection(
  ctx: CaptureContext,
  captureId: string,
): CollectionView {
  const row = isUUID(captureId)
    ? ctx.db.get<RevisionRow>(sql`
        SELECT ${sql.raw(REVISION_COLUMNS)}
        FROM captures c
        JOIN collections a ON a.id = c.collection_id
        JOIN revisions r ON r.id = c.revision_id
        LEFT JOIN library l ON l.collection_id = a.id
        WHERE c.id = ${captureId}`)
    : undefined
  if (!row) throw new AppError('not_found')
  const collection = view(
    row,
    parseJson<Payload>(row.payload),
    assetsByCapture(ctx, [row.capture_id]).get(row.capture_id) ?? [],
  )
  applyMetrics(
    collection.graph,
    captureMetrics(ctx, captureId) ?? captureMetrics(ctx, row.capture_id),
  )
  return collection
}

export interface RevisionInfo {
  id: string
  created_at: string
}

const REVISION_PAGE = 20

function encodeCursor(at: number, id: string, filter: string): string {
  return Buffer.from(JSON.stringify({ t: at, id, f: filter })).toString(
    'base64url',
  )
}

function decodeRevisionCursor(cursor: string, filter: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      value?.f === filter &&
      Number.isSafeInteger(value.t) &&
      isUUID(value.id)
    )
      return { at: value.t as number, id: value.id as string }
  } catch {}
  throw new AppError('invalid_cursor')
}

/** A saved collection's revisions, newest first. */
export function listRevisions(
  ctx: CaptureContext,
  id: string,
  cursor?: string,
): Page<RevisionInfo> {
  const after = cursor ? decodeRevisionCursor(cursor, id) : undefined
  assertSaved(ctx, id)
  const rows = ctx.db.all<{ id: string; created_at: number }>(sql`
    SELECT id, created_at FROM revisions
    WHERE collection_id = ${id}
      ${after ? sql`AND (created_at, id) < (${after.at}, ${after.id})` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${REVISION_PAGE + 1}`)
  const items = rows.slice(0, REVISION_PAGE)
  const last = items.at(-1)
  return {
    items: items.map((row) => ({
      id: row.id,
      created_at: iso(row.created_at),
    })),
    ...(rows.length > REVISION_PAGE && last
      ? { next_cursor: encodeCursor(last.created_at, last.id, id) }
      : {}),
  }
}

/**
 * One past revision of a saved collection, as it was captured: its own
 * capture's media and counts, observed when the revision was made.
 */
export function getRevision(
  ctx: CaptureContext,
  id: string,
  revisionId: string,
): CollectionView {
  assertSaved(ctx, id)
  const row = isUUID(revisionId)
    ? ctx.db.get<RevisionRow>(sql`
        SELECT ${sql.raw(REVISION_COLUMNS)}
        FROM collections a
        JOIN library l ON l.collection_id = a.id
        JOIN revisions r ON r.collection_id = a.id
        WHERE a.id = ${id} AND r.id = ${revisionId}`)
    : undefined
  if (!row) throw new AppError('not_found')
  const collection = view(
    { ...row, observed_at: row.revision_at },
    parseJson<Payload>(row.payload),
    assetsByCapture(ctx, [row.capture_id]).get(row.capture_id) ?? [],
  )
  applyMetrics(collection.graph, captureMetrics(ctx, row.capture_id))
  linkSavedEntities(ctx, collection)
  attachIncomingRelations(ctx, collection)
  collection.storage_bytes = collectionStorage(ctx, id)
  return collection
}
