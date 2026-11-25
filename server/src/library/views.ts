import { sql, type SQL } from 'drizzle-orm'
import { overlayMetrics } from '#capture/metrics.ts'
import {
  metricKey,
  type Metrics,
  type Payload,
  type PayloadEntity,
  type PayloadRelation,
} from '#capture/payload.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Executor } from '#db/client.ts'

/** What reads need from the capture context. */
export type Reader = Pick<CaptureContext, 'db' | 'blobs'>

/** A media item as the web shows it, with signed URLs to fetch it. */
export interface AssetView {
  id: string
  purpose?: string
  position: number
  state: string
  error?: string
  alt_text?: string
  sensitive: boolean
  sha256?: string
  mime?: string
  size: number
  /** A small derived image exists. */
  thumbnail?: boolean
  /**
   * The thumbnail's pixel size, in the original's proportions: for the
   * aspect ratio only (the thumbnail is smaller than the original).
   */
  width?: number
  height?: number
  /** The original, for ready media. */
  url?: string
  thumbnail_url?: string
  /** The original as an attachment named `file_name`. */
  download_url?: string
  file_name?: string
  /** `image` or `video`, kept when the media is removed. */
  kind: string
  /**
   * Removed (`state` is `removed`, 已移除) and no longer marked so: the
   * next capture downloads it again (恢复下载).
   */
  download_again?: true
  /**
   * The platform's own address of an avatar or banner that was never
   * downloaded (an account known only from a follow list, say), for the
   * web to show from the platform. Absent once the image is saved here,
   * and on platforms whose image addresses expire (see `REMOTE_IMAGES`).
   */
  remote_url?: string
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

export interface EntityVersionView {
  id: string
  data: Record<string, unknown>
  assets?: AssetView[]
}

export interface EntityView {
  id?: string
  version_id?: string
  key: string
  type: string
  external_id: string
  data: Record<string, unknown>
  resource_indices?: number[]
  context_only?: boolean
  assets?: AssetView[]
  /** The saved collection about this entity. */
  saved_collection_id?: string
  /** For a post kept by reference: what its saved collection says now. */
  saved_summary?: string
  saved_text?: string
  saved_author?: EntityView
  /** An author's newest complete version, when it differs from this one. */
  current?: EntityVersionView
}

export interface GraphView {
  root: string
  entities: EntityView[]
  relations: PayloadRelation[]
}

export interface IncomingRelation {
  type: string
  entity: EntityView
  author?: EntityView
}

export interface CollectionView {
  id: string
  url: string
  external_id: string
  provider_id: string
  revision_id: string
  text: string
  text_kind: string
  text_source?: string
  adapter_version: string
  author_name?: string
  published_at?: string
  summary?: string
  warnings: string[]
  assets: AssetView[]
  graph?: GraphView
  observed_at: string
  created_at: string
  source_state?: 'deleted' | 'suspended'
  source_state_at?: string
  saved_at?: string
  storage_bytes?: number
  relation_types?: string[]
  incoming_relations?: IncomingRelation[]
}

export interface Page<T> {
  items: T[]
  next_cursor?: string
  total_storage_bytes?: number
}

/** The newest revision of the collection named by `column`. */
export const head = (column: string) =>
  `(SELECT h.id FROM revisions h WHERE h.collection_id = ${column} ORDER BY h.created_at DESC, h.id DESC LIMIT 1)`

/** A JSON array parameter, to be read with json_each. */
export const list = (values: readonly unknown[]): SQL =>
  sql.join([sql.param(JSON.stringify(values))])

export const iso = (ms: number | Date): string => new Date(ms).toISOString()

export function parseJson<T>(raw: unknown): T {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T
}

interface AssetRow {
  capture_id: string
  id: string
  purpose: string
  position: number
  alt_text: string
  sensitive: number
  state: string
  error: string
  hash: string | null
  mime: string | null
  size: number | null
  /** The blob's upload to the remote store is confirmed. */
  remote: number | null
  thumb_key: string | null
  thumb_mime: string | null
  thumb_width: number | null
  thumb_height: number | null
  marked: number
  kind: string
  source_url: string
  platform: string
}

function assetRows(r: Reader, where: SQL): AssetRow[] {
  return r.db.all<AssetRow>(sql`
    SELECT a.capture_id, a.id, a.purpose, a.position, a.alt_text, a.sensitive,
      a.state, a.error, a.kind, a.source_url, b.hash, b.mime, b.size,
      b.remote_at IS NOT NULL AS remote,
      coalesce(t.key, rm.thumbnail_key) AS thumb_key,
      coalesce(t.mime, rm.thumbnail_mime) AS thumb_mime,
      coalesce(t.width, rm.thumbnail_width) AS thumb_width,
      coalesce(t.height, rm.thumbnail_height) AS thumb_height,
      rm.media_key IS NOT NULL AS marked, co.platform
    FROM assets a
    JOIN captures ca ON ca.id = a.capture_id
    JOIN collections co ON co.id = ca.collection_id
    LEFT JOIN blobs b ON b.id = a.blob_id
    LEFT JOIN blob_thumbnails t ON t.blob_id = a.blob_id AND t.state = 'ready'
    -- Removed media is shown by the thumbnail its mark kept.
    LEFT JOIN removed_media rm
      ON a.state = 'removed' AND rm.media_key = a.media_key
    WHERE ${where}
    ORDER BY a.capture_id, a.position`)
}

/** Images that stand for an account, which may be shown from the platform. */
const ACCOUNT_IMAGES = new Set(['avatar', 'banner'])

/**
 * Platforms whose image addresses keep working, so an account image not
 * saved here can be shown from them. Instagram's expire: there an
 * undownloaded avatar falls back to the initial instead of a broken image.
 * Mutable only so tests can let the fake platform stand in for X.
 */
export const REMOTE_IMAGES = new Set(['x'])

/** The platform's address of an account image not saved here, if any. */
function remoteURL(row: AssetRow): string | undefined {
  if (
    row.kind !== 'image' ||
    !ACCOUNT_IMAGES.has(row.purpose) ||
    !REMOTE_IMAGES.has(row.platform)
  )
    return
  try {
    const url = new URL(row.source_url)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return
  }
}

function assetView(r: Reader, row: AssetRow): AssetView {
  const ready = row.state === 'ready' && !!row.hash
  const removed = row.state === 'removed'
  const remote = ready || removed ? undefined : remoteURL(row)
  const thumbnail = !!row.thumb_key && !!row.thumb_mime
  const fileName = `${row.id}.${EXTENSIONS[row.mime ?? ''] ?? 'bin'}`
  return {
    id: row.id,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    position: row.position,
    state: row.state,
    kind: row.kind,
    ...(removed && !row.marked ? { download_again: true as const } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.alt_text ? { alt_text: row.alt_text } : {}),
    sensitive: !!row.sensitive,
    ...(row.hash ? { sha256: row.hash } : {}),
    ...(row.mime ? { mime: row.mime } : {}),
    size: row.size ?? 0,
    ...(thumbnail ? { thumbnail: true } : {}),
    ...(thumbnail && row.thumb_width && row.thumb_height
      ? { width: row.thumb_width, height: row.thumb_height }
      : {}),
    ...(ready
      ? {
          url: r.blobs.url(row.hash!, {
            contentType: row.mime!,
            remote: !!row.remote,
          }),
          download_url: r.blobs.url(row.hash!, {
            contentType: row.mime!,
            filename: fileName,
          }),
          file_name: fileName,
        }
      : {}),
    ...((ready || removed) && thumbnail
      ? {
          thumbnail_url: r.blobs.url(row.thumb_key!, {
            contentType: row.thumb_mime!,
          }),
        }
      : {}),
    ...(remote ? { remote_url: remote } : {}),
  }
}

/** Every asset of each capture, in position order. */
export function assetsByCapture(
  r: Reader,
  captureIds: readonly string[],
): Map<string, AssetView[]> {
  const out = new Map<string, AssetView[]>(captureIds.map((id) => [id, []]))
  if (!captureIds.length) return out
  for (const row of assetRows(
    r,
    sql`a.capture_id IN (SELECT value FROM json_each(${list(captureIds)}))`,
  ))
    out.get(row.capture_id)?.push(assetView(r, row))
  return out
}

export function assetsById(
  r: Reader,
  ids: readonly string[],
): Map<string, AssetView> {
  if (!ids.length) return new Map()
  return new Map(
    assetRows(r, sql`a.id IN (SELECT value FROM json_each(${list(ids)}))`).map(
      (row) => [row.id, assetView(r, row)],
    ),
  )
}

/**
 * The avatar among the resources of entity `keyColumn` in revision
 * `revision`, as an SQL expression yielding the asset id: the first ready
 * one, or else one only the platform has (see `remote_url`).
 */
export const avatarOf = (revision: string, keyColumn: string) => `(
  SELECT av.id FROM json_each(${revision}.payload, '$.graph.entities') ge
  JOIN json_each(ge.value, '$.resource_indices') gi
  JOIN assets av ON av.capture_id = ${revision}.capture_id
    AND av.position = gi.value AND av.purpose = 'avatar'
    AND (av.state = 'ready' OR (av.kind = 'image' AND av.source_url LIKE 'https://%'
      AND (SELECT co.platform FROM captures ca
        JOIN collections co ON co.id = ca.collection_id
        WHERE ca.id = av.capture_id) IN (${[...REMOTE_IMAGES].map((p) => `'${p}'`).join(', ')})))
  WHERE ge.value ->> 'key' = ${keyColumn}
  ORDER BY av.state = 'ready' DESC, av.position LIMIT 1)`

export function entityView(entity: PayloadEntity): EntityView {
  return {
    ...(entity.id ? { id: entity.id } : {}),
    ...(entity.version_id ? { version_id: entity.version_id } : {}),
    key: entity.key,
    type: entity.type,
    external_id: entity.external_id,
    data: entity.data,
    ...(entity.resource_indices?.length
      ? { resource_indices: entity.resource_indices }
      : {}),
    ...(entity.context_only ? { context_only: true } : {}),
  }
}

/**
 * Revision content as a collection: content media on the collection, and
 * each entity's media (avatars included) on the entity.
 */
export function hydrate(
  payload: Payload,
  all: AssetView[],
): Pick<
  CollectionView,
  | 'author_name'
  | 'published_at'
  | 'summary'
  | 'text'
  | 'text_kind'
  | 'text_source'
  | 'adapter_version'
  | 'warnings'
  | 'assets'
  | 'graph'
> {
  const graph: GraphView | undefined = payload.graph && {
    root: payload.graph.root,
    entities: payload.graph.entities.map((e) => entityView(e)),
    relations: payload.graph.relations,
  }
  for (const asset of all)
    for (const entity of graph?.entities ?? [])
      for (const position of entity.resource_indices ?? [])
        if (position === asset.position) (entity.assets ??= []).push(asset)
  return {
    ...(payload.author_name ? { author_name: payload.author_name } : {}),
    ...(payload.published_at ? { published_at: payload.published_at } : {}),
    ...(payload.summary ? { summary: payload.summary } : {}),
    text: payload.text,
    text_kind: payload.text_kind,
    ...(payload.text_source ? { text_source: payload.text_source } : {}),
    adapter_version: payload.adapter_version,
    warnings: payload.warnings ?? [],
    assets: all.filter((a) => !a.purpose),
    ...(graph ? { graph } : {}),
  }
}

/** Put a capture's observed counts back into the graph. */
export function applyMetrics(
  graph: GraphView | undefined,
  metrics: Metrics | null | undefined,
): void {
  if (!graph || !metrics) return
  for (const entity of graph.entities)
    entity.data = overlayMetrics(entity.data, metrics[metricKey(entity)])
}

/** The counts a capture observed, if any. */
export function metricsOf(
  r: { db: Executor },
  captureId: string,
): Metrics | undefined {
  const row = r.db.get<{ metrics: string }>(
    sql`SELECT metrics FROM capture_metrics WHERE capture_id = ${captureId}`,
  )
  return row ? parseJson<Metrics>(row.metrics) : undefined
}
