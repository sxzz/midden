import { Buffer } from 'node:buffer'
import { and, asc, desc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
  blobs,
  captures,
  collections,
  entities,
  entityRelations,
  entityVersions,
  revisionEntities,
  revisions,
} from '#db/schema.ts'
import { catalogCollections } from '#library/catalog.ts'
import { canonicalJson, sha256Hex } from './json.ts'
import {
  deliveries,
  failCapture,
  loadCapture,
  validateExecution,
} from './lifecycle.ts'
import { splitMetrics } from './metrics.ts'
import { unsaveIfEmpty } from './scope.ts'
import { markUnreferenced } from './submit.ts'
import type { Transaction } from '#db/client.ts'
import type { Job } from '#jobs/queue.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { CaptureContext } from './context.ts'
import type { Payload, PayloadGraph } from './payload.ts'

export interface AssetState {
  position: number
  purpose: string
  hash: string
  altText: string
  sensitive: boolean
  state: string
  error: string
}

function captureAssets(tx: Transaction, captureId: string): AssetState[] {
  return tx
    .select({
      position: assets.position,
      purpose: assets.purpose,
      hash: blobs.hash,
      altText: assets.altText,
      sensitive: assets.sensitive,
      state: assets.state,
      error: assets.error,
    })
    .from(assets)
    .leftJoin(blobs, eq(blobs.id, assets.blobId))
    .where(eq(assets.captureId, captureId))
    .orderBy(asc(assets.position))
    .all()
    .map((asset) => ({ ...asset, hash: asset.hash ?? '' }))
}

// Code-unit order, independent of locale.
function byteOrder(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const identity = (entity: { type: string; external_id: string }) =>
  `${entity.type}/${entity.external_id}`

/**
 * Per entity type, the paths a revision leaves out of its digest: the
 * observed counts, and what the platform reports inconsistently.
 */
export function ignoredPaths(
  platforms: Platforms,
  adapterId: string,
  metricPaths: Record<string, string[]> = {},
): Record<string, string[]> {
  const paths: Record<string, string[]> = {}
  for (const [type, list] of Object.entries(metricPaths))
    paths[type] = [...list]
  const platform = platforms
    .all()
    .find((p) => p.description.adapterId === adapterId)
  for (const type of platform?.description.entityTypes ?? [])
    paths[type.name] = [
      ...new Set([
        ...(paths[type.name] ?? []),
        ...type.metricPaths,
        ...type.volatilePaths,
      ]),
    ]
  return paths
}

/**
 * What decides whether a capture is a new revision. Context entities (such
 * as a post's author) count only by identity, with their media; observed
 * counts, values the platform reports inconsistently, and local key
 * numbering never count.
 *
 * `view` leaves out what a history point does not show either: the posts a
 * profile's timeline reposted. They are recorded so the profile's list can
 * mark them, and that list draws on every revision; a capture that did not
 * read the timeline (an automatic refresh) has none of them.
 */
export function revisionDigest(
  payload: Payload,
  captureAssets: AssetState[],
  context: Set<string>,
  ignored: Record<string, string[]>,
  view = false,
): string {
  // Comparable form: keys renamed to identities, context reduced to them.
  let graph: object | undefined
  const contextPositions = new Set<number>()
  const contentPositions = new Set<number>()
  const omitted = new Set<string>()
  let relations = payload.graph?.relations ?? []
  if (payload.graph && view) {
    const root = payload.graph.root
    const listing = (r: { source: string; type: string }) =>
      r.source === root && r.type === 'reposted'
    relations = relations.filter((r) => !listing(r))
    const kept = new Set(relations.flatMap((r) => [r.source, r.target]))
    for (const r of payload.graph.relations)
      if (listing(r) && r.target !== root && !kept.has(r.target))
        omitted.add(r.target)
  }
  if (payload.graph) {
    const rootIdentity = payload.graph.entities.find(
      (e) => e.key === payload.graph!.root,
    )
    const keys = new Map(
      payload.graph.entities.map((e) => [e.key, identity(e)]),
    )
    graph = {
      root: rootIdentity ? identity(rootIdentity) : payload.graph.root,
      entities: payload.graph.entities
        .flatMap((entity) => {
          const id = identity(entity)
          const isContext =
            omitted.has(entity.key) ||
            (context.has(id) && entity.key !== payload.graph!.root)
          for (const index of entity.resource_indices ?? [])
            (isContext ? contextPositions : contentPositions).add(index)
          if (omitted.has(entity.key)) return []
          if (isContext)
            return {
              key: id,
              type: entity.type,
              external_id: entity.external_id,
            }
          return {
            key: id,
            type: entity.type,
            external_id: entity.external_id,
            data: splitMetrics(entity.data, ignored[entity.type] ?? []).data,
            resource_indices: entity.resource_indices ?? [],
          }
        })
        .toSorted((a, b) => byteOrder(a.key, b.key)),
      relations: relations
        .map((r) => ({
          source: keys.get(r.source) ?? r.source,
          target: keys.get(r.target) ?? r.target,
          type: r.type,
        }))
        .toSorted((a, b) =>
          byteOrder(
            `${a.source}|${a.type}|${a.target}`,
            `${b.source}|${b.type}|${b.target}`,
          ),
        ),
    }
  }
  const hasContext =
    payload.graph?.entities.some(
      (e) =>
        context.has(identity(e)) &&
        e.key !== payload.graph!.root &&
        !omitted.has(e.key),
    ) ?? false
  return sha256Hex(
    canonicalJson({
      text: payload.text,
      kind: payload.text_kind,
      summary: hasContext ? '' : (payload.summary ?? ''),
      authorName: hasContext ? '' : (payload.author_name ?? ''),
      publishedAt: payload.published_at ?? '',
      graph: graph ?? null,
      warnings: payload.warnings,
      assets: captureAssets
        .filter(
          (a) =>
            !contextPositions.has(a.position) ||
            contentPositions.has(a.position),
        )
        .map((a) => ({
          purpose: a.purpose,
          hash: a.hash,
          altText: a.altText,
          sensitive: a.sensitive,
          state: a.state,
          error: a.error,
        })),
    }),
  )
}

/**
 * Store each graph entity and its version. Entities are shared by platform
 * identity; versions by content (data plus the state of its media), and the
 * first stored data for a content hash is kept.
 */
function persistEntities(
  tx: Transaction,
  platform: string,
  graph: PayloadGraph,
  captureAssets: AssetState[],
  now: Date,
): void {
  const byPosition = new Map<number, AssetState>()
  for (const asset of captureAssets)
    if (!byPosition.has(asset.position)) byPosition.set(asset.position, asset)
  for (const entity of graph.entities) {
    const media = (entity.resource_indices ?? []).map((index) => {
      const asset = byPosition.get(index)
      return asset
        ? [
            asset.purpose,
            asset.hash,
            asset.state,
            asset.altText,
            asset.sensitive,
            asset.error,
          ]
        : null
    })
    const contentHash = sha256Hex(canonicalJson([entity.data, media]))
    let entityId = tx
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.platform, platform),
          eq(entities.kind, entity.type),
          eq(entities.externalId, entity.external_id),
        ),
      )
      .get()?.id
    if (entityId)
      tx.update(entities)
        .set({ observedAt: now })
        .where(eq(entities.id, entityId))
        .run()
    else {
      entityId = newId()
      tx.insert(entities)
        .values({
          id: entityId,
          platform,
          kind: entity.type,
          externalId: entity.external_id,
          observedAt: now,
        })
        .run()
    }
    let versionId = tx
      .select({ id: entityVersions.id })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.entityId, entityId),
          eq(entityVersions.contentHash, contentHash),
        ),
      )
      .get()?.id
    if (!versionId) {
      versionId = newId()
      tx.insert(entityVersions)
        .values({ id: versionId, entityId, contentHash, data: entity.data })
        .run()
    }
    entity.id = entityId
    entity.version_id = versionId
  }
}

/**
 * Rows to insert with one statement each: few enough to stay below SQLite's
 * limit on bound values.
 */
function* chunks<T>(rows: T[], size = 1000): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
}

/**
 * Turn a capture whose media have settled into a revision, or reuse the
 * newest one when nothing that counts as content changed.
 */
export function runFinalize(ctx: CaptureContext, job: Job): void {
  ctx.db.transaction((tx) => {
    const capture = loadCapture(tx, job.ref)
    if (capture?.state !== 'downloading') return
    const states = captureAssets(tx, capture.id)
    if (states.some((a) => a.state === 'pending')) return
    validateExecution(tx, capture)
    const payload = capture.payload as Payload
    const ready = states.filter((a) => a.state === 'ready' && !a.purpose).length
    const partial =
      !!payload.incomplete || states.some((a) => a.state !== 'ready')
    if (!payload.text && ready === 0 && !payload.graph) {
      failCapture(ctx, tx, capture.id, '没有可保存的正文或媒体')
      return
    }
    const now = new Date(ctx.now?.() ?? Date.now())
    const collection = tx
      .select()
      .from(collections)
      .where(eq(collections.id, capture.collectionId))
      .get()!
    if (payload.graph)
      persistEntities(tx, collection.platform, payload.graph, states, now)

    const context = new Set(
      (payload.graph?.entities ?? [])
        .filter((e) => e.context_only)
        .map(identity),
    )
    const ignored = ignoredPaths(
      ctx.platforms,
      capture.adapterId,
      payload.metric_paths,
    )
    const digest = revisionDigest(payload, states, context, ignored)
    const previous = tx
      .select()
      .from(revisions)
      .where(eq(revisions.collectionId, collection.id))
      .orderBy(desc(revisions.createdAt), desc(revisions.id))
      .limit(1)
      .get()
    let revisionId = previous?.id
    if (
      !previous ||
      revisionDigest(
        previous.payload as Payload,
        captureAssets(tx, previous.captureId),
        context,
        ignored,
      ) !== digest
    ) {
      revisionId = newId()
      const body = JSON.stringify(payload)
      tx.insert(revisions)
        .values({
          id: revisionId,
          collectionId: collection.id,
          captureId: capture.id,
          contentHash: digest,
          viewHash: revisionDigest(payload, states, context, ignored, true),
          payload,
          contentBytes: Buffer.byteLength(body),
          createdAt: now,
        })
        .run()
      for (const entities of chunks(payload.graph?.entities ?? []))
        tx.insert(revisionEntities)
          .values(
            entities.map((entity) => ({
              revisionId: revisionId!,
              entityKey: entity.key,
              entityVersionId: entity.version_id!,
              isRoot: entity.key === payload.graph!.root,
            })),
          )
          .run()
      for (const relations of chunks(payload.graph?.relations ?? []))
        tx.insert(entityRelations)
          .values(
            relations.map((relation) => ({
              revisionId: revisionId!,
              sourceKey: relation.source,
              targetKey: relation.target,
              kind: relation.type,
            })),
          )
          .onConflictDoNothing()
          .run()
      tx.update(collections)
        .set({ currentRevision: revisionId })
        .where(eq(collections.id, collection.id))
        .run()
    }
    tx.update(captures)
      .set({
        state: partial ? 'partial' : 'complete',
        payload: null,
        finishedAt: now,
        revisionId,
        metrics: payload.metrics ?? null,
      })
      .where(eq(captures.id, capture.id))
      .run()
    tx.update(collections)
      .set({ observedAt: now, sourceState: null, sourceStateAt: null })
      .where(eq(collections.id, collection.id))
      .run()
    catalogCollections(tx, [collection.id])
    // A refresh that turned out to be another collection (canonicalized).
    if (capture.refreshFrom && capture.refreshFrom !== collection.id) {
      unsaveIfEmpty(tx, capture.refreshFrom)
      markUnreferenced(tx, capture.refreshFrom, now)
    }
    deliveries(ctx, tx, capture.id)
  })
}
