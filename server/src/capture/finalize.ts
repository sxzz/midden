import { Buffer } from 'node:buffer'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
  blobs,
  captureMetrics,
  captures,
  collections,
  entities,
  entityRelations,
  entityVersions,
  revisionEntities,
  revisions,
} from '#db/schema.ts'
import { catalogCollections } from '#library/catalog.ts'
import { PINNED_POSTS } from '#platforms/listing.ts'
import { enqueueRawUpload } from '#raw/upload.ts'
import { canonicalJson, sha256Hex } from './json.ts'
import {
  deliveries,
  failCapture,
  loadCapture,
  validateExecution,
} from './lifecycle.ts'
import { overlayMetrics, splitMetrics, valueAt } from './metrics.ts'
import { unsaveIfEmpty } from './scope.ts'
import { loadStaging, settleStaging } from './staging.ts'
import { markUnreferenced } from './submit.ts'
import type { Transaction } from '#db/client.ts'
import type { Job } from '#jobs/queue.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { CaptureContext } from './context.ts'
import type { Payload, PayloadEntity, PayloadGraph } from './payload.ts'

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
 * profile's timeline reposted, and the ones it pinned. The reposts are
 * recorded so the profile's list can mark them, and that list draws on every
 * revision; a capture that did not read the timeline (an automatic refresh)
 * has none of them, nor knows what is pinned. Pinned posts are listed with
 * the profile's changes instead.
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
            data: splitMetrics(
              entity.data,
              view && entity.key === payload.graph!.root
                ? [...(ignored[entity.type] ?? []), PINNED_POSTS]
                : (ignored[entity.type] ?? []),
            ).data,
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
 * How each entity of a capture is told apart from its other versions: its
 * data together with the state of its media.
 */
export function entityContentHashes(
  captureAssets: AssetState[],
): (entity: PayloadEntity) => string {
  const byPosition = new Map<number, AssetState>()
  for (const asset of captureAssets)
    if (!byPosition.has(asset.position)) byPosition.set(asset.position, asset)
  return (entity) => {
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
    return sha256Hex(canonicalJson([entity.data, media]))
  }
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
  const hashOf = entityContentHashes(captureAssets)
  for (const entity of graph.entities) {
    const contentHash = hashOf(entity)
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
export function* chunks<T>(rows: T[], size = 1000): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
}

const rootOf = (payload: Payload) =>
  payload.graph?.entities.find((e) => e.key === payload.graph!.root)

/**
 * How a capture compares with the revision before it as far as a profile's
 * pinned posts go. A capture that could not tell which posts are pinned
 * changes nothing by them, so they are left out on both sides. One that
 * could is compared with the last ones known, which the revision before it
 * may not have recorded.
 */
function pinnedComparison(
  tx: Transaction,
  collectionId: string,
  payload: Payload,
  previous: Payload | undefined,
  ignored: Record<string, string[]>,
): { previous: Payload | undefined; ignored: Record<string, string[]> } {
  const root = rootOf(payload)
  if (!root || !previous) return { previous, ignored }
  if (valueAt(root.data, PINNED_POSTS) === undefined)
    return {
      previous,
      ignored: {
        ...ignored,
        [root.type]: [...(ignored[root.type] ?? []), PINNED_POSTS],
      },
    }
  const before = rootOf(previous)
  if (!before || valueAt(before.data, PINNED_POSTS) !== undefined)
    return { previous, ignored }
  const known = tx.get<{ pinned: string }>(sql`
    SELECT v.data -> '$.metadata.pinned_posts' AS pinned
    FROM revisions rv
    JOIN revision_entities re ON re.revision_id = rv.id AND re.is_root = 1
    JOIN entity_versions v ON v.id = re.entity_version_id
    WHERE rv.collection_id = ${collectionId}
      AND json_type(v.data, '$.metadata.pinned_posts') = 'array'
    ORDER BY rv.created_at DESC, rv.id DESC
    LIMIT 1`)
  if (!known) return { previous, ignored }
  const filled = structuredClone(previous)
  const filledRoot = rootOf(filled)!
  filledRoot.data = overlayMetrics(filledRoot.data, {
    [PINNED_POSTS]: JSON.parse(known.pinned),
  })
  return { previous: filled, ignored }
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
    if (capture.revisionId) {
      settleRetriedMedia(ctx, tx, capture, states)
      return
    }
    validateExecution(tx, capture)
    const staging = loadStaging(tx, capture.id)
    const payload = staging?.payload
    if (!staging || !payload) {
      failCapture(ctx, tx, capture.id, '采集被中断')
      return
    }
    // Removed media (已移除) was left out on purpose: still content, and
    // nothing missing.
    const kept = (a: AssetState) => a.state === 'ready' || a.state === 'removed'
    const ready = states.filter((a) => kept(a) && !a.purpose).length
    const partial = !!payload.incomplete || states.some((a) => !kept(a))
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
    const previous = tx
      .select()
      .from(revisions)
      .where(eq(revisions.collectionId, collection.id))
      .orderBy(desc(revisions.createdAt), desc(revisions.id))
      .limit(1)
      .get()
    const compared = pinnedComparison(
      tx,
      collection.id,
      payload,
      previous?.payload as Payload | undefined,
      ignored,
    )
    const digest = revisionDigest(payload, states, context, compared.ignored)
    let revisionId = previous?.id
    if (
      !previous ||
      revisionDigest(
        compared.previous!,
        captureAssets(tx, previous.captureId),
        context,
        compared.ignored,
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
        finishedAt: now,
        revisionId,
      })
      .where(eq(captures.id, capture.id))
      .run()
    if (payload.metrics)
      tx.insert(captureMetrics)
        .values({ captureId: capture.id, metrics: payload.metrics })
        .run()
    settleStaging(tx, staging)
    enqueueRawUpload(ctx, tx, capture.id)
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

/**
 * A finished capture downloaded its failed media again (see
 * `capture/retries.ts`): its revision, when it made one, now shows them,
 * so the hashes that compare it are those of what it holds now. Nothing
 * was fetched, so the collection is not observed anew, and a newer
 * revision stays the current one.
 */
function settleRetriedMedia(
  ctx: CaptureContext,
  tx: Transaction,
  capture: NonNullable<ReturnType<typeof loadCapture>>,
  states: AssetState[],
): void {
  const own = tx
    .select()
    .from(revisions)
    .where(eq(revisions.captureId, capture.id))
    .get()
  const shown =
    own ??
    tx
      .select()
      .from(revisions)
      .where(eq(revisions.id, capture.revisionId!))
      .get()
  const payload = shown?.payload as Payload | undefined
  const kept = (a: AssetState) => a.state === 'ready' || a.state === 'removed'
  const partial = !!payload?.incomplete || states.some((a) => !kept(a))
  const now = new Date(ctx.now?.() ?? Date.now())
  if (own && payload) {
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
    tx.update(revisions)
      .set({
        payload,
        contentHash: revisionDigest(payload, states, context, ignored),
        viewHash: revisionDigest(payload, states, context, ignored, true),
        contentBytes: Buffer.byteLength(JSON.stringify(payload)),
      })
      .where(eq(revisions.id, own.id))
      .run()
    for (const entity of payload.graph?.entities ?? [])
      tx.update(revisionEntities)
        .set({ entityVersionId: entity.version_id! })
        .where(
          and(
            eq(revisionEntities.revisionId, own.id),
            eq(revisionEntities.entityKey, entity.key),
          ),
        )
        .run()
    catalogCollections(tx, [collection.id])
  }
  tx.update(captures)
    .set({ state: partial ? 'partial' : 'complete', finishedAt: now })
    .where(eq(captures.id, capture.id))
    .run()
  deliveries(ctx, tx, capture.id)
}
