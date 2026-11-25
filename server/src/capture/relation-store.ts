import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
  captureMetrics,
  captures,
  collections,
  entities,
  entityRelations,
  entityVersions,
  library,
  revisionEntities,
  revisions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { catalogCollections } from '#library/catalog.ts'
import { provider as findProvider } from '#platforms/registry.ts'
import { stage } from './fetch.ts'
import {
  chunks,
  entityContentHashes,
  ignoredPaths,
  revisionDigest,
  type AssetState,
} from './finalize.ts'
import type { Transaction } from '#db/client.ts'
import type { Platform, RelationList } from '#platforms/platform.ts'
import type { FetchResponse } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'
import type { Payload } from './payload.ts'

/** Why a listed account's images are missing from the version it made. */
export const LISTED_MEDIA = '来自关注列表的资料，未下载图片'

/** Where listed accounts are saved from: the source of the listing profile. */
export interface ListSource {
  adapterId: string
  providerId: string
  connectionId: string | null
}

interface Listed {
  externalId: string
  /** The entity type of the account, e.g. `x.profile`. */
  type: string
  url: string
  target: { platform: string; kind: string; objectScope: string }
  /** Absent when the listing's data did not make a valid profile. */
  staged?: ReturnType<typeof stage>
}

/**
 * Save a page of listed accounts: each becomes a profile in the library,
 * and one without any version gets one from the list's data. A profile that
 * has a version keeps it untouched, so partial list data never shows up as a
 * change of a profile fetched for real. Returns the account entity ids by
 * external id. Batched per page: a fixed number of statements however many
 * accounts the page lists.
 */
export function storeListed(
  ctx: CaptureContext,
  tx: Transaction,
  platform: Platform,
  accounts: FetchResponse[],
  source: ListSource,
  now: Date,
): Map<string, string> {
  const policy = findProvider(platform, source.providerId)
  const listed = new Map<string, Listed>()
  for (const account of accounts) {
    const canonical = account.canonicalTarget
    const root = account.graph?.entities.find(
      (e) => e.key === account.graph!.root,
    )
    if (!canonical || !root || root.externalId !== canonical.externalId)
      continue
    let target
    try {
      target = ctx.platforms.resolve(canonical.url).target
    } catch {
      continue
    }
    if (target.externalId !== canonical.externalId || !target.collection)
      continue
    const item: Listed = {
      externalId: target.externalId,
      type: root.type,
      url: target.url,
      target,
    }
    try {
      item.staged = stage(
        { ...account, externalId: target.externalId, providerId: policy.id },
        policy,
        platform.description.entityTypes,
        { ...target, providerId: policy.id },
      )
    } catch {
      // The account is still listed; only its version is left out.
    }
    listed.set(item.externalId, item)
  }
  if (!listed.size) return new Map()
  const items = [...listed.values()]

  const entityIds = upsertEntities(
    tx,
    items.map((item) => ({
      platform: item.target.platform,
      type: item.type,
      externalId: item.externalId,
    })),
    now,
  )
  const accountIds = new Map(
    items.map((item) => [
      item.externalId,
      entityIds.get(`${item.type}/${item.externalId}`)!,
    ]),
  )

  // Profiles: one per account, saved in the library.
  const found = new Map(
    tx
      .select({
        id: collections.id,
        externalId: collections.externalId,
        currentRevision: collections.currentRevision,
      })
      .from(collections)
      .where(
        sql`${collections.platform} = ${items[0]!.target.platform}
          AND ${collections.kind} = ${items[0]!.target.kind}
          AND ${collections.objectScope} = ''
          AND ${inJson(
            collections.externalId,
            items.map((i) => i.externalId),
          )}`,
      )
      .all()
      .map((row) => [row.externalId, row]),
  )
  const fresh = items
    .filter((item) => !found.has(item.externalId))
    .map((item) => ({
      id: newId(),
      platform: item.target.platform,
      kind: item.target.kind,
      objectScope: item.target.objectScope,
      externalId: item.externalId,
      url: item.url,
      providerId: source.providerId,
      createdAt: now,
      observedAt: now,
    }))
  for (const rows of chunks(fresh, 200))
    tx.insert(collections).values(rows).run()
  for (const row of fresh)
    found.set(row.externalId, { ...row, currentRevision: null })
  const collectionIds = items.map((item) => found.get(item.externalId)!.id)
  for (const ids of chunks(collectionIds, 200))
    tx.insert(library)
      .values(
        ids.map((collectionId) => ({
          collectionId,
          providerId: source.providerId,
          connectionId: source.connectionId,
          adapterId: source.adapterId,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .run()
  tx.update(collections)
    .set({ unreferencedAt: null })
    .where(
      sql`${inJson(collections.id, collectionIds)} AND ${collections.unreferencedAt} IS NOT NULL`,
    )
    .run()

  const versionless = items.filter(
    (item) => item.staged && !found.get(item.externalId)!.currentRevision,
  )
  if (versionless.length)
    storeVersions(
      ctx,
      tx,
      versionless.map((item) => ({
        collectionId: found.get(item.externalId)!.id,
        platform: item.target.platform,
        staged: item.staged!,
      })),
      source,
      now,
    )
  return accountIds
}

/** Entity ids by `<type>/<external id>`, creating the ones not seen before. */
function upsertEntities(
  tx: Transaction,
  wanted: { platform: string; type: string; externalId: string }[],
  now: Date,
): Map<string, string> {
  const ids = new Map<string, string>()
  const groups = Map.groupBy(wanted, (e) => `${e.platform}\n${e.type}`)
  for (const group of groups.values()) {
    const { platform, type } = group[0]!
    const externalIds = [...new Set(group.map((e) => e.externalId))]
    for (const rows of chunks(externalIds, 200))
      tx.insert(entities)
        .values(
          rows.map((externalId) => ({
            id: newId(),
            platform,
            kind: type,
            externalId,
            observedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [entities.platform, entities.kind, entities.externalId],
          set: { observedAt: now },
        })
        .run()
    for (const row of tx
      .select({ id: entities.id, externalId: entities.externalId })
      .from(entities)
      .where(
        sql`${entities.platform} = ${platform} AND ${entities.kind} = ${type}
          AND ${inJson(entities.externalId, externalIds)}`,
      )
      .all())
      ids.set(`${type}/${row.externalId}`, row.id)
  }
  return ids
}

/**
 * The first version of profiles known only from a list: a finished capture
 * of each, its media recorded as not downloaded (so they count as unknown,
 * never as removed), and a revision, written in batches.
 */
function storeVersions(
  ctx: CaptureContext,
  tx: Transaction,
  rows: {
    collectionId: string
    platform: string
    staged: ReturnType<typeof stage>
  }[],
  source: ListSource,
  now: Date,
): void {
  const entityIds = upsertEntities(
    tx,
    rows.flatMap((row) =>
      (row.staged.payload.graph?.entities ?? []).map((e) => ({
        platform: row.platform,
        type: e.type,
        externalId: e.external_id,
      })),
    ),
    now,
  )
  const prepared = rows.map((row) => {
    const payload: Payload = structuredClone(row.staged.payload)
    payload.incomplete = true
    const states: AssetState[] = row.staged.resources.map((resource, i) => ({
      position: i,
      purpose: resource.purpose,
      hash: '',
      altText: resource.altText,
      sensitive: resource.sensitive,
      state: 'failed',
      error: LISTED_MEDIA,
    }))
    const hashOf = entityContentHashes(states)
    const versions = (payload.graph?.entities ?? []).map((entity) => {
      entity.id = entityIds.get(`${entity.type}/${entity.external_id}`)!
      return { entity, contentHash: hashOf(entity) }
    })
    return { ...row, payload, states, versions }
  })

  const versions = prepared.flatMap((row) => row.versions)
  for (const batch of chunks(versions, 200))
    tx.insert(entityVersions)
      .values(
        batch.map(({ entity, contentHash }) => ({
          id: newId(),
          entityId: entity.id!,
          contentHash,
          data: entity.data,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .run()
  const stored = new Map(
    tx
      .select({
        id: entityVersions.id,
        entityId: entityVersions.entityId,
        contentHash: entityVersions.contentHash,
      })
      .from(entityVersions)
      .where(
        sql`${inJson(
          entityVersions.entityId,
          versions.map((v) => v.entity.id),
        )} AND ${inJson(
          entityVersions.contentHash,
          versions.map((v) => v.contentHash),
        )}`,
      )
      .all()
      .map((row) => [`${row.entityId}\n${row.contentHash}`, row.id]),
  )
  for (const { entity, contentHash } of versions)
    entity.version_id = stored.get(`${entity.id}\n${contentHash}`)!

  const scope = source.connectionId
    ? `connection:${source.connectionId}`
    : 'public'
  const made = prepared.map((row) => {
    const context = new Set(
      (row.payload.graph?.entities ?? [])
        .filter((e) => e.context_only)
        .map((e) => `${e.type}/${e.external_id}`),
    )
    const paths = ignoredPaths(
      ctx.platforms,
      source.adapterId,
      row.payload.metric_paths,
    )
    const body = JSON.stringify(row.payload)
    return {
      ...row,
      captureId: newId(),
      revisionId: newId(),
      digest: revisionDigest(row.payload, row.states, context, paths),
      viewHash: revisionDigest(row.payload, row.states, context, paths, true),
      bytes: Buffer.byteLength(body),
    }
  })
  for (const batch of chunks(made, 200)) {
    tx.insert(captures)
      .values(
        batch.map((row) => ({
          id: row.captureId,
          collectionId: row.collectionId,
          providerId: source.providerId,
          adapterId: source.adapterId,
          connectionId: source.connectionId,
          scope,
          state: 'partial' as const,
          automatic: true,
          adapterVersion: row.payload.adapter_version,
          createdAt: now,
          finishedAt: now,
          revisionId: row.revisionId,
        })),
      )
      .run()
    const counted = batch.filter((row) => row.payload.metrics)
    if (counted.length)
      tx.insert(captureMetrics)
        .values(
          counted.map((row) => ({
            captureId: row.captureId,
            metrics: row.payload.metrics!,
          })),
        )
        .run()
    tx.insert(revisions)
      .values(
        batch.map((row) => ({
          id: row.revisionId,
          collectionId: row.collectionId,
          captureId: row.captureId,
          contentHash: row.digest,
          viewHash: row.viewHash,
          payload: row.payload,
          contentBytes: row.bytes,
          createdAt: now,
        })),
      )
      .run()
  }
  const media = made.flatMap((row) =>
    row.staged.resources.map((resource, position) => ({
      id: newId(),
      captureId: row.captureId,
      position,
      sourceUrl: resource.url,
      kind: resource.kind as 'image' | 'video',
      altText: resource.altText,
      sensitive: resource.sensitive,
      purpose: resource.purpose,
      state: 'failed' as const,
      error: LISTED_MEDIA,
    })),
  )
  for (const batch of chunks(media, 200)) tx.insert(assets).values(batch).run()
  const links = made.flatMap((row) =>
    (row.payload.graph?.entities ?? []).map((entity) => ({
      revisionId: row.revisionId,
      entityKey: entity.key,
      entityVersionId: entity.version_id!,
      isRoot: entity.key === row.payload.graph!.root,
    })),
  )
  for (const batch of chunks(links, 200))
    tx.insert(revisionEntities).values(batch).run()
  const relations = made.flatMap((row) =>
    (row.payload.graph?.relations ?? []).map((relation) => ({
      revisionId: row.revisionId,
      sourceKey: relation.source,
      targetKey: relation.target,
      kind: relation.type,
    })),
  )
  for (const batch of chunks(relations, 200))
    tx.insert(entityRelations).values(batch).onConflictDoNothing().run()
  const heads = made.map((row) => [row.collectionId, row.revisionId])
  tx.run(sql`UPDATE collections SET current_revision = j.value ->> 1,
      observed_at = ${now.getTime()}, source_state = NULL, source_state_at = NULL
    FROM json_each(${JSON.stringify(heads)}) j
    WHERE collections.id = j.value ->> 0`)
  catalogCollections(
    tx,
    made.map((row) => row.collectionId),
  )
}

/** Record that each listed account is in the list of `subject`. */
export function observeEdges(
  tx: Transaction,
  list: RelationList,
  subject: string,
  accounts: readonly string[],
  now: Date,
): void {
  if (!accounts.length) return
  const pairs = accounts.map((account) =>
    list === 'following' ? [subject, account] : [account, subject],
  )
  const at = now.getTime()
  for (const batch of chunks(pairs, 500))
    tx.run(sql`INSERT INTO follow_edges
        (follower_id, followee_id, first_seen_at, last_seen_at)
      SELECT j.value ->> 0, j.value ->> 1, ${at}, ${at}
      FROM json_each(${JSON.stringify(batch)}) j WHERE true
      ON CONFLICT (follower_id, followee_id) WHERE ended_at IS NULL
      DO UPDATE SET last_seen_at = excluded.last_seen_at`)
}
