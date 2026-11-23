import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { AppError } from '#errors.ts'
import { isUUID } from './read.ts'
import { iso } from './views.ts'
import type { CaptureContext } from '#capture/context.ts'

/** A raw upstream response kept with a finished capture. */
export interface SourceResponse {
  id: string
  capture_id: string
  provider_id: string
  adapter_version: string
  content_type: string
  source_url: string
  sha256: string
  size: number
  created_at: string
}

const MAX_SOURCES = 100

/** The newest raw responses of a saved collection's finished captures. */
export function listSources(
  ctx: CaptureContext,
  collectionId: string,
): SourceResponse[] {
  if (
    !isUUID(collectionId) ||
    !ctx.db.get(
      sql`SELECT 1 AS x FROM library WHERE collection_id = ${collectionId}`,
    )
  )
    throw new AppError('not_found')
  return ctx.db
    .all<Omit<SourceResponse, 'created_at'> & { created_at: number }>(
      sql`
      SELECT sr.id, sr.capture_id, c.provider_id, c.adapter_version,
        sr.content_type, sr.source_url, sr.sha256, sr.size, sr.created_at
      FROM source_responses sr
      JOIN captures c ON c.id = sr.capture_id
      WHERE c.collection_id = ${collectionId}
        AND c.state IN ('complete', 'partial')
      ORDER BY sr.created_at DESC, sr.id DESC
      LIMIT ${MAX_SOURCES}`,
    )
    .map((row) => ({ ...row, created_at: iso(row.created_at) }))
}

/** One raw response body, byte for byte. */
export function getSource(
  ctx: CaptureContext,
  id: string,
): { id: string; body: Buffer; content_type: string } {
  const row = isUUID(id)
    ? ctx.db.get<{ id: string; body: Uint8Array; content_type: string }>(sql`
        SELECT sr.id, sr.body, sr.content_type
        FROM source_responses sr
        JOIN captures c ON c.id = sr.capture_id
        JOIN library l ON l.collection_id = c.collection_id
        WHERE sr.id = ${id} AND c.state IN ('complete', 'partial')`)
    : undefined
  if (!row) throw new AppError('not_found')
  return {
    id: row.id,
    body: Buffer.from(row.body),
    content_type: row.content_type,
  }
}
