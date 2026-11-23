import { Buffer } from 'node:buffer'
import path from 'node:path'
import pg from 'pg'
import { Vault } from '../../../server/src/accounts/vault.ts'
import {
  revisionDigest,
  type AssetState,
} from '../../../server/src/capture/finalize.ts'
import { deriveKey } from '../../../server/src/crypto.ts'
import { openDatabase, type Database } from '../../../server/src/db/client.ts'
import * as schema from '../../../server/src/db/schema.ts'
import { catalogMissing } from '../../../server/src/library/catalog.ts'
import {
  contextOf,
  convertOptions,
  convertPayload,
  convertTargets,
  entityMedia,
  entityVersionHash,
  openLegacyCredential,
} from './convert.ts'
import {
  copyMedia,
  type BlobToCopy,
  type MediaReport,
  type ObjectSource,
} from './media.ts'
import type { Connection } from './postgres.ts'

export const INTERRUPTED = 'capture was interrupted'
export const BATCH_INTERRUPTED = 'refresh was interrupted'

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/

export interface ImportOptions {
  legacy: Connection
  objects: ObjectSource
  /** The new data directory; must not contain a database yet. */
  dataDir: string
  /** The new service's SECRET_KEY. */
  secretKey: string
  /** The old CREDENTIAL_KEY, decoded; needed when accounts exist. */
  credentialKey?: Uint8Array
  /**
   * The owner's tenant id; required when the old database has several.
   * Library, notes, tags, accounts and records come only from it.
   */
  tenant?: string
  now?: Date
  log?: (message: string) => void
}

export interface TableReport {
  legacy: string
  target: string
  legacyRows: number
  importedRows: number
  note?: string
}

export interface ImportReport {
  tables: TableReport[]
  media: MediaReport
}

// bigint columns hold sizes and counters, far below 2^53.
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === pg.types.builtins.INT8)
      return (value: string) => {
        const number = Number(value)
        if (!Number.isSafeInteger(number))
          throw new Error(`integer out of range: ${value}`)
        return number
      }
    return pg.types.getTypeParser(oid, format)
  }) as pg.CustomTypesConfig['getTypeParser'],
}

/** Reads the old database inside one read-only snapshot. */
class Legacy {
  readonly #client: pg.Client
  #cursors = 0

  constructor(client: pg.Client) {
    this.#client = client
  }

  async rows<T>(text: string, values?: unknown[]): Promise<T[]> {
    return (await this.#client.query(text, values)).rows as T[]
  }

  async count(table: string): Promise<number> {
    const [row] = await this.rows<{ n: number }>(
      `SELECT count(*) AS n FROM ${table}`,
    )
    return row.n
  }

  /** Stream a query's rows in batches through a server-side cursor. */
  async *batches<T>(text: string, size = 500): AsyncGenerator<T[]> {
    const name = `import_${++this.#cursors}`
    await this.#client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${text}`)
    try {
      for (;;) {
        const { rows } = await this.#client.query(`FETCH ${size} FROM ${name}`)
        if (!rows.length) return
        yield rows as T[]
      }
    } finally {
      await this.#client.query(`CLOSE ${name}`)
    }
  }

  /** Each capture's assets in the shape `finalize` hashes. */
  async assetStates(captureIds: string[]): Promise<Map<string, AssetState[]>> {
    const out = new Map<string, AssetState[]>()
    if (!captureIds.length) return out
    const rows = await this.rows<AssetState & { captureId: string }>(
      `SELECT a.capture_id AS "captureId", a.position, a.purpose,
          coalesce(b.hash, '') AS hash, a.alt_text AS "altText", a.sensitive,
          a.state, a.error
        FROM assets a LEFT JOIN blobs b ON b.id = a.blob_id
        WHERE a.capture_id = ANY($1::uuid[])
        ORDER BY a.capture_id, a.position`,
      [captureIds],
    )
    for (const { captureId, ...asset } of rows) {
      const list = out.get(captureId) ?? []
      list.push(asset)
      out.set(captureId, list)
    }
    return out
  }
}

function chunks<T>(rows: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * Convert the old service's database into a new data directory: `midden.db`
 * created by the new migrations, and `media/` keyed by content hash.
 */
export async function importLegacy(
  options: ImportOptions,
): Promise<ImportReport> {
  const log = options.log ?? (() => {})
  const now = options.now ?? new Date()
  const client = new pg.Client({ ...options.legacy, types })
  await client.connect()
  const db = openDatabase(path.join(options.dataDir, 'midden.db'))
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const legacy = new Legacy(client)
    const tables = await importTables(legacy, db, options, now, log)
    log('copying media')
    const blobs = await legacy.rows<BlobToCopy>(
      `SELECT id, hash, size, object_key AS "objectKey" FROM blobs ORDER BY id`,
    )
    await client.query('COMMIT')
    let reported = 0
    const media = await copyMedia(
      options.objects,
      blobs,
      path.join(options.dataDir, 'media'),
      {
        onProgress(done) {
          if (done - reported < 500 && done !== blobs.length) return
          reported = done
          log(`media ${done}/${blobs.length}`)
        },
      },
    )
    // The library lists from the catalog, which finalize keeps up to date.
    // The rows above bypassed finalize, so rebuild every row from the final
    // tables rather than trusting any that exist.
    log('building the library catalog')
    db.$client.exec('DELETE FROM catalog')
    catalogMissing(db)
    verify(db)
    for (const table of tables) table.importedRows = countRows(db, table.target)
    db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { tables, media }
  } finally {
    db.$client.close()
    await client.end()
  }
}

function countRows(db: Database, table: string): number {
  if (table === '—') return 0
  const row = db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get()
  return Number(row?.n ?? 0)
}

function verify(db: Database): void {
  const broken = db.$client.prepare('PRAGMA foreign_key_check').all()
  if (broken.length)
    throw new Error(
      `foreign key check failed: ${JSON.stringify(broken.slice(0, 5))}`,
    )
  const integrity = db.$client.prepare('PRAGMA integrity_check').get()
  if (integrity?.integrity_check !== 'ok')
    throw new Error(`integrity check failed: ${JSON.stringify(integrity)}`)
}

async function importTables(
  legacy: Legacy,
  db: Database,
  options: ImportOptions,
  now: Date,
  log: (message: string) => void,
): Promise<TableReport[]> {
  const tenants = await legacy.rows<{ id: string }>('SELECT id FROM tenants')
  if (!options.tenant && tenants.length > 1)
    throw new Error(
      `the old database has ${tenants.length} tenants; choose the owner's with --tenant`,
    )
  const owner = options.tenant ?? tenants[0]?.id
  if (!owner || !UUID.test(owner) || tenants.every((t) => t.id !== owner))
    throw new Error(`no tenant ${owner ?? ''} in the old database`)
  // Checked to be a UUID above, so it can sit in SQL text (cursors take no
  // parameters).
  const mine = `tenant_id = '${owner}'`

  const tables: TableReport[] = []
  /** `scoped`: rows belong to tenants, and only the owner's are imported. */
  const table = async (
    legacyTable: string,
    target: string,
    run: () => Promise<string | void>,
    scoped = false,
  ) => {
    log(`importing ${legacyTable}`)
    const legacyRows = await legacy.count(legacyTable)
    const others = scoped
      ? await legacy.count(`${legacyTable} WHERE NOT ${mine}`)
      : 0
    const notes = [
      ...(others ? [`${others} of other tenants skipped`] : []),
      ...[await run()].filter(Boolean),
    ]
    tables.push({
      legacy: legacyTable,
      target,
      legacyRows,
      importedRows: 0,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    })
  }

  // What only other tenants saved is left for maintenance to remove, like
  // anything the owner no longer keeps.
  let released = 0
  const unreferenced = (row: {
    saved: boolean
    unreferenced_at: Date | null
  }) => {
    if (row.saved || row.unreferenced_at) return row.unreferenced_at
    released++
    return now
  }
  await table('collections', 'collections', async () => {
    for await (const rows of legacy.batches<{
      id: string
      platform: string
      kind: string
      object_scope: string
      external_id: string
      url: string
      provider_id: string
      current_revision: string | null
      unreferenced_at: Date | null
      created_at: Date
      observed_at: Date
      source_state: 'deleted' | 'suspended' | null
      source_state_at: Date | null
      saved: boolean
    }>(
      `SELECT c.*, EXISTS (SELECT 1 FROM tenant_collections tc
          WHERE tc.collection_id = c.id AND tc.${mine}) AS saved
        FROM collections c ORDER BY c.id`,
    ))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.collections)
            .values(
              chunk.map((row) => ({
                id: row.id,
                platform: row.platform,
                kind: row.kind,
                objectScope: row.object_scope,
                externalId: row.external_id,
                url: row.url,
                providerId: row.provider_id,
                currentRevision: row.current_revision,
                unreferencedAt: unreferenced(row),
                createdAt: row.created_at,
                observedAt: row.observed_at,
                sourceState: row.source_state,
                sourceStateAt: row.source_state_at,
              })),
            )
            .run()
      })
    if (released)
      return `${released} not saved by the owner → unreferenced (maintenance removes them)`
  })

  await table(
    'collection_identity_aliases',
    'collection_identity_aliases',
    async () => {
      for await (const rows of legacy.batches<{
        platform: string
        kind: string
        object_scope: string
        external_id: string
        collection_id: string
      }>(
        'SELECT * FROM collection_identity_aliases ORDER BY platform, kind, object_scope, external_id',
      ))
        db.transaction((tx) => {
          for (const chunk of chunks(rows))
            tx.insert(schema.collectionIdentityAliases)
              .values(
                chunk.map((row) => ({
                  platform: row.platform,
                  kind: row.kind,
                  objectScope: row.object_scope,
                  externalId: row.external_id,
                  collectionId: row.collection_id,
                })),
              )
              .run()
        })
    },
  )

  await table(
    'tenant_collections',
    'library',
    async () => {
      for await (const rows of legacy.batches<{
        collection_id: string
        provider_id: string
        connection_id: string | null
        adapter_id: string
        note: string
        created_at: Date
      }>(
        `SELECT * FROM tenant_collections WHERE ${mine} ORDER BY collection_id`,
      ))
        db.transaction((tx) => {
          for (const chunk of chunks(rows))
            tx.insert(schema.library)
              .values(
                chunk.map((row) => ({
                  collectionId: row.collection_id,
                  providerId: row.provider_id,
                  connectionId: row.connection_id,
                  adapterId: row.adapter_id,
                  note: row.note,
                  createdAt: row.created_at,
                })),
              )
              .run()
        })
    },
    true,
  )

  // Nothing will resume work that was in flight: settle it the way the new
  // service's maintenance settles captures that lost their jobs.
  const interrupted = new Set<string>()
  await table('captures', 'captures', async () => {
    for await (const rows of legacy.batches<{
      id: string
      collection_id: string
      provider_id: string
      adapter_id: string
      connection_id: string | null
      credential_revision: number | null
      refresh_from: string | null
      scope: string
      state: schema.CaptureState
      error: string
      payload: unknown
      adapter_version: string
      created_at: Date
      finished_at: Date | null
      revision_id: string | null
      automatic: boolean
      related_targets: unknown
      page_size: number
      page_cursor: string
      next_page_cursor: string
      is_collection: boolean
      max_batch_size: number
      prefetch: Buffer | null
      metrics: unknown
    }>('SELECT * FROM captures ORDER BY id', 200))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.captures)
            .values(
              chunk.map((row) => {
                const active =
                  row.state === 'queued' || row.state === 'downloading'
                if (active) interrupted.add(row.id)
                return {
                  id: row.id,
                  collectionId: row.collection_id,
                  providerId: row.provider_id,
                  adapterId: row.adapter_id,
                  connectionId: row.connection_id,
                  credentialRevision: row.credential_revision,
                  refreshFrom: row.refresh_from,
                  scope: row.scope,
                  state: active ? 'failed' : row.state,
                  error: active ? INTERRUPTED : row.error,
                  payload:
                    active || row.payload == null
                      ? null
                      : convertPayload(row.payload, new Map()),
                  adapterVersion: row.adapter_version,
                  createdAt: row.created_at,
                  finishedAt: active ? now : row.finished_at,
                  revisionId: row.revision_id,
                  automatic: row.automatic,
                  relatedTargets: convertTargets(row.related_targets),
                  pageSize: row.page_size,
                  pageCursor: row.page_cursor,
                  nextPageCursor: row.next_page_cursor,
                  isCollection: row.is_collection,
                  maxBatchSize: row.max_batch_size,
                  prefetch: active ? null : row.prefetch,
                  metrics: row.metrics ?? null,
                }
              }),
            )
            .run()
      })
    if (interrupted.size)
      return `${interrupted.size} queued/downloading → failed (${INTERRUPTED})`
  })

  await table('entities', 'entities', async () => {
    for await (const rows of legacy.batches<{
      id: string
      platform: string
      kind: string
      external_id: string
      observed_at: Date
    }>(
      `SELECT * FROM entities e
        WHERE EXISTS (SELECT 1 FROM entity_versions ev
          JOIN revision_entities re ON re.entity_version_id = ev.id
          WHERE ev.entity_id = e.id)
        ORDER BY id`,
    ))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.entities)
            .values(
              chunk.map((row) => ({
                id: row.id,
                platform: row.platform,
                kind: row.kind,
                externalId: row.external_id,
                observedAt: row.observed_at,
              })),
            )
            .run()
      })
    const [{ n }] = await legacy.rows<{ n: number }>(
      `SELECT count(*) AS n FROM entities e WHERE NOT EXISTS (
        SELECT 1 FROM entity_versions ev
        JOIN revision_entities re ON re.entity_version_id = ev.id
        WHERE ev.entity_id = e.id)`,
    )
    if (n) return `${n} without any referenced version skipped`
  })

  // The old hash covered the JSON Schema too, so versions that differed only
  // by schema now hash alike; they merge into the oldest one.
  const merged = new Map<string, string>()
  await table('entity_versions', 'entity_versions', async () => {
    const kept = new Map<string, string>()
    for await (const rows of legacy.batches<{
      id: string
      entity_id: string
      data: unknown
      created_at: Date
      capture_id: string
      indices: number[]
    }>(
      // Media states come from the first revision that used the version, as
      // when finalize created it.
      `SELECT * FROM (
        SELECT DISTINCT ON (ev.id) ev.id, ev.entity_id, ev.data, ev.created_at,
          r.capture_id, coalesce(g.e -> 'resource_indices', '[]') AS indices
        FROM entity_versions ev
        JOIN revision_entities re ON re.entity_version_id = ev.id
        JOIN revisions r ON r.id = re.revision_id
        LEFT JOIN LATERAL (
          SELECT e FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(r.payload -> 'graph' -> 'entities') = 'array'
              THEN r.payload -> 'graph' -> 'entities' ELSE '[]' END) e
          WHERE e ->> 'key' = re.entity_key LIMIT 1) g ON true
        ORDER BY ev.id, r.created_at, r.id) v
      ORDER BY created_at, id`,
    )) {
      const assets = await legacy.assetStates([
        ...new Set(rows.map((row) => row.capture_id)),
      ])
      const values: (typeof schema.entityVersions.$inferInsert)[] = []
      for (const row of rows) {
        const hash = entityVersionHash(
          row.data,
          entityMedia(row.indices, assets.get(row.capture_id) ?? []),
        )
        const identity = `${row.entity_id}/${hash}`
        const existing = kept.get(identity)
        if (existing) {
          merged.set(row.id, existing)
          continue
        }
        kept.set(identity, row.id)
        values.push({
          id: row.id,
          entityId: row.entity_id,
          contentHash: hash,
          data: row.data,
          createdAt: row.created_at,
        })
      }
      db.transaction((tx) => {
        for (const chunk of chunks(values))
          tx.insert(schema.entityVersions).values(chunk).run()
      })
    }
    const [{ n }] = await legacy.rows<{ n: number }>(
      `SELECT count(*) AS n FROM entity_versions ev WHERE NOT EXISTS (
        SELECT 1 FROM revision_entities re WHERE re.entity_version_id = ev.id)`,
    )
    const notes = []
    if (n) notes.push(`${n} unreferenced skipped`)
    if (merged.size) notes.push(`${merged.size} merged into an equal version`)
    return notes.join('; ')
  })

  await table('revisions', 'revisions', async () => {
    for await (const rows of legacy.batches<{
      id: string
      collection_id: string
      capture_id: string
      payload: unknown
      created_at: Date
    }>(
      'SELECT id, collection_id, capture_id, payload, created_at FROM revisions ORDER BY id',
      200,
    )) {
      const assets = await legacy.assetStates(rows.map((row) => row.capture_id))
      const values = rows.map((row) => {
        const payload = convertPayload(row.payload, merged)
        return {
          id: row.id,
          collectionId: row.collection_id,
          captureId: row.capture_id,
          contentHash: revisionDigest(
            payload,
            assets.get(row.capture_id) ?? [],
            contextOf(payload),
            payload.metric_paths ?? {},
          ),
          payload,
          contentBytes: Buffer.byteLength(JSON.stringify(payload)),
          createdAt: row.created_at,
        }
      })
      db.transaction((tx) => {
        for (const chunk of chunks(values, 50))
          tx.insert(schema.revisions).values(chunk).run()
      })
    }
  })

  await table('revision_entities', 'revision_entities', async () => {
    for await (const rows of legacy.batches<{
      revision_id: string
      entity_key: string
      entity_version_id: string
      is_root: boolean
    }>(
      'SELECT * FROM revision_entities ORDER BY revision_id, entity_key',
      2000,
    ))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.revisionEntities)
            .values(
              chunk.map((row) => ({
                revisionId: row.revision_id,
                entityKey: row.entity_key,
                entityVersionId:
                  merged.get(row.entity_version_id) ?? row.entity_version_id,
                isRoot: row.is_root,
              })),
            )
            .run()
      })
  })

  await table('entity_relations', 'entity_relations', async () => {
    for await (const rows of legacy.batches<{
      revision_id: string
      source_key: string
      target_key: string
      kind: string
    }>(
      'SELECT * FROM entity_relations ORDER BY revision_id, source_key, kind, target_key',
      2000,
    ))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.entityRelations)
            .values(
              chunk.map((row) => ({
                revisionId: row.revision_id,
                sourceKey: row.source_key,
                targetKey: row.target_key,
                kind: row.kind,
              })),
            )
            .run()
      })
  })

  await table('blobs', 'blobs', async () => {
    for await (const rows of legacy.batches<{
      id: string
      hash: string
      size: number
      mime: string
      created_at: Date | null
    }>(
      // Blobs had no creation time; the first capture that used one is close.
      `SELECT b.id, b.hash, b.size, b.mime,
          (SELECT min(c.created_at) FROM assets a
            JOIN captures c ON c.id = a.capture_id
            WHERE a.blob_id = b.id) AS created_at
        FROM blobs b ORDER BY b.id`,
      2000,
    ))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.blobs)
            .values(
              chunk.map((row) => ({
                id: row.id,
                hash: row.hash,
                size: row.size,
                mime: row.mime,
                createdAt: row.created_at ?? now,
              })),
            )
            .run()
      })
  })

  await table('assets', 'assets', async () => {
    let failed = 0
    for await (const rows of legacy.batches<{
      id: string
      capture_id: string
      position: number
      source_url: string
      purpose: string
      alt_text: string
      sensitive: boolean
      cache_key: string
      kind: 'image' | 'video'
      state: 'pending' | 'ready' | 'failed'
      error: string
      blob_id: string | null
    }>('SELECT * FROM assets ORDER BY id', 2000))
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.assets)
            .values(
              chunk.map((row) => {
                const settle =
                  row.state === 'pending' && interrupted.has(row.capture_id)
                if (settle) failed++
                return {
                  id: row.id,
                  captureId: row.capture_id,
                  position: row.position,
                  sourceUrl: row.source_url,
                  purpose: row.purpose,
                  altText: row.alt_text,
                  sensitive: row.sensitive,
                  cacheKey: row.cache_key,
                  kind: row.kind,
                  state: settle ? 'failed' : row.state,
                  error: settle ? INTERRUPTED : row.error,
                  blobId: row.blob_id,
                }
              }),
            )
            .run()
      })
    if (failed) return `${failed} pending of interrupted captures → failed`
  })

  await table('source_responses', 'source_responses', async () => {
    let dropped = 0
    for await (const rows of legacy.batches<{
      id: string
      capture_id: string
      position: number
      body: Buffer
      content_type: string
      source_url: string
      sha256: string
      size: number
      created_at: Date
    }>(
      `SELECT id, capture_id, position, body, content_type, source_url,
          sha256, size, created_at
        FROM source_responses ORDER BY id`,
      // Bodies reach 4 MiB each.
      20,
    )) {
      // A failed capture keeps no raw responses.
      const kept = rows.filter((row) => !interrupted.has(row.capture_id))
      dropped += rows.length - kept.length
      db.transaction((tx) => {
        for (const chunk of chunks(kept, 10))
          tx.insert(schema.sourceResponses)
            .values(
              chunk.map((row) => ({
                id: row.id,
                captureId: row.capture_id,
                position: row.position,
                body: row.body,
                contentType: row.content_type,
                sourceUrl: row.source_url,
                sha256: row.sha256,
                size: row.size,
                createdAt: row.created_at,
              })),
            )
            .run()
      })
    }
    if (dropped) return `${dropped} of interrupted captures dropped`
  })

  await table(
    'submissions',
    'submissions',
    async () => {
      let settled = 0
      for await (const rows of legacy.batches<{
        id: string
        capture_id: string
        idem_key: string
        fingerprint: string
        input: string
        created_at: Date
        related_provider: string
        related_connection: string | null
        related_adapter: string
        related_source_collection: string | null
        related_state: string
        related_error: string
        collection_limit: number
        next_submission: string | null
        collection_stopped: boolean
        parent_submission: string | null
        capture_options: unknown
      }>(`SELECT * FROM submissions WHERE ${mine} ORDER BY id`, 2000))
        db.transaction((tx) => {
          for (const chunk of chunks(rows))
            tx.insert(schema.submissions)
              .values(
                chunk.map((row) => {
                  const state = relatedState(row.related_state)
                  // A page whose fan-out was due has no job left to run it.
                  const settle = state === 'pending' && !row.collection_stopped
                  if (settle) settled++
                  return {
                    id: row.id,
                    captureId: row.capture_id,
                    idemKey: row.idem_key,
                    fingerprint: row.fingerprint,
                    input: row.input,
                    createdAt: row.created_at,
                    relatedProvider: row.related_provider,
                    relatedConnection: row.related_connection,
                    relatedAdapter: row.related_adapter,
                    relatedSourceCollection: row.related_source_collection,
                    relatedState: settle ? 'failed' : state,
                    relatedError: settle ? INTERRUPTED : row.related_error,
                    collectionLimit: row.collection_limit,
                    nextSubmission: row.next_submission,
                    collectionStopped: row.collection_stopped,
                    parentSubmission: row.parent_submission,
                    captureOptions: convertOptions(row.capture_options),
                  }
                }),
              )
              .run()
        })
      if (settled)
        return `${settled} pending fan-outs → failed (${INTERRUPTED})`
    },
    true,
  )

  await table(
    'refresh_batches',
    'refresh_batches',
    async () => {
      let settled = 0
      for await (const rows of legacy.batches<{
        id: string
        collection_ids: string[]
        position: number
        reused: number
        rejected: number
        capture_ids: string[]
        state: 'running' | 'complete' | 'failed'
        error: string
        created_at: Date
      }>(
        `SELECT id, array_to_json(collection_ids) AS collection_ids, position,
          reused, rejected, array_to_json(capture_ids) AS capture_ids, state,
          error, created_at
        FROM refresh_batches WHERE ${mine} ORDER BY id`,
      ))
        db.transaction((tx) => {
          for (const chunk of chunks(rows))
            tx.insert(schema.refreshBatches)
              .values(
                chunk.map((row) => {
                  const settle = row.state === 'running'
                  if (settle) settled++
                  return {
                    id: row.id,
                    collectionIds: row.collection_ids,
                    position: row.position,
                    reused: row.reused,
                    rejected: row.rejected,
                    captureIds: row.capture_ids,
                    state: settle ? 'failed' : row.state,
                    error: settle ? BATCH_INTERRUPTED : row.error,
                    createdAt: row.created_at,
                  }
                }),
              )
              .run()
        })
      if (settled) return `${settled} running → failed (${BATCH_INTERRUPTED})`
    },
    true,
  )

  await table(
    'tags',
    'tags',
    async () => {
      const rows = await legacy.rows<{ id: string; name: string }>(
        `SELECT id, name FROM tags WHERE ${mine} ORDER BY id`,
      )
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.tags).values(chunk).run()
      })
    },
    true,
  )

  await table(
    'collection_tags',
    'collection_tags',
    async () => {
      const rows = await legacy.rows<{ collection_id: string; tag_id: string }>(
        `SELECT collection_id, tag_id FROM collection_tags WHERE ${mine}
        ORDER BY collection_id, tag_id`,
      )
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.collectionTags)
            .values(
              chunk.map((row) => ({
                collectionId: row.collection_id,
                tagId: row.tag_id,
              })),
            )
            .run()
      })
    },
    true,
  )

  await table(
    'connections',
    'connections',
    async () => {
      const rows = await legacy.rows<{
        id: string
        adapter_id: string
        provider_id: string
        name: string
        account_id: string | null
        username: string | null
        state: 'pending' | 'ready' | 'reauth_required' | 'revoked'
        credential_ref: string | null
        revision: number
      }>(`SELECT * FROM connections WHERE ${mine} ORDER BY id`)
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.connections)
            .values(
              chunk.map((row) => ({
                id: row.id,
                adapterId: row.adapter_id,
                providerId: row.provider_id,
                name: row.name,
                accountId: row.account_id,
                username: row.username,
                state: row.state,
                credentialRef: row.credential_ref,
                revision: row.revision,
                // Not recorded by the old service.
                createdAt: now,
              })),
            )
            .run()
      })
    },
    true,
  )

  await table(
    'account_credentials',
    'account_credentials',
    async () => {
      const rows = await legacy.rows<{
        id: string
        tenant_id: string
        ciphertext: Buffer
      }>(
        `SELECT id, tenant_id, ciphertext FROM account_credentials
        WHERE ${mine} ORDER BY id`,
      )
      if (!rows.length) return
      if (!options.credentialKey)
        throw new Error(
          `${rows.length} account credentials need the old CREDENTIAL_KEY`,
        )
      const vault = new Vault(deriveKey(options.secretKey, 'credentials'))
      const values = rows.map((row) => {
        const plain = openLegacyCredential(
          options.credentialKey!,
          row.tenant_id,
          row.id,
          row.ciphertext,
        )
        const ciphertext = vault.seal(row.id, plain)
        if (!vault.unseal(row.id, ciphertext).equals(plain))
          throw new Error(`credential ${row.id} did not survive re-encryption`)
        return { id: row.id, ciphertext }
      })
      db.transaction((tx) => {
        for (const chunk of chunks(values))
          tx.insert(schema.accountCredentials).values(chunk).run()
      })
      return 're-encrypted with SECRET_KEY'
    },
    true,
  )

  await table(
    'tenant_preferences',
    'account_selections',
    async () => {
      const rows = await legacy.rows<{
        adapter_id: string
        default_connection_id: string | null
      }>(
        `SELECT adapter_id, default_connection_id FROM tenant_preferences
        WHERE ${mine} ORDER BY adapter_id`,
      )
      db.transaction((tx) => {
        for (const chunk of chunks(rows))
          tx.insert(schema.accountSelections)
            .values(
              chunk.map((row) => ({
                adapterId: row.adapter_id,
                connectionId: row.default_connection_id,
              })),
            )
            .run()
      })
    },
    true,
  )

  await table('blob_thumbnails', '—', () =>
    Promise.resolve('not imported; maintenance renders them again'),
  )

  return tables
}

const RELATED_STATES = ['none', 'pending', 'complete', 'failed'] as const

function relatedState(value: string): (typeof RELATED_STATES)[number] {
  const state = RELATED_STATES.find((s) => s === value)
  if (!state) throw new Error(`unknown related_state: ${value}`)
  return state
}
