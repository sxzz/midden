// Starting an update (更新): what a target holds, the sheet's preview of it,
// and the update's row. A folder's members take one read of the library, so
// the web process plans an update on a read thread (`planUpdate`) and only
// writes it here, checking that the plan still holds (`startUpdate`).
import { and, desc, eq, inArray } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  captureMetrics,
  captures,
  collections,
  entities,
  entityVersions,
  folders,
  library,
  revisionEntities,
  revisions,
  updates,
  type UpdateTarget,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError } from '#errors.ts'
import {
  catalogTypes,
  folderKey,
  folderSelection,
} from '#library/folder-query.ts'
import { updateSelection } from '#library/list.ts'
import {
  checkOptions,
  DEFAULT_OPTIONS,
  type CaptureOptions,
} from './options.ts'
import type { Executor } from '#db/client.ts'
import type { ReadContext } from '#library/views.ts'
import type { Types } from '#query/compile.ts'
import type { CaptureContext } from './context.ts'

/** A library selection updates at most this many collections. */
const MAX_SELECTION = 500
/** A folder updates at most this many. */
const MAX_FOLDER = 10_000
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export type UpdateTargetInput =
  | { target: 'collection'; id: string }
  | { target: 'folder'; id: string }
  | { target: 'many'; ids: string[] }

export interface UpdateOptions {
  /** What each item captures; the defaults when absent. */
  options?: CaptureOptions
  /** Profiles read on from the page after their last one. */
  older?: boolean
  /** Idempotency key: a repeat returns the update it started. */
  key?: string
  /** The watch (定期更新) starting it; its work ranks below manual work. */
  watchId?: string
  /** What the target holds, read beforehand (`planUpdate`). */
  plan?: UpdatePlan
}

// --- Targets ----------------------------------------------------------------

/** What a target holds, each collection once. */
export interface UpdatePlan {
  target: UpdateTarget
  targetId: string
  name: string
  collectionIds: string[]
  /** What a folder's query selected them by (`folderKey`). */
  key?: string
}

export function savedIds(db: Executor, ids: string[]): Set<string> {
  return new Set(
    ids.length
      ? db
          .select({ id: library.collectionId })
          .from(library)
          .where(inJson(library.collectionId, ids))
          .all()
          .map((row) => row.id)
      : [],
  )
}

/** What a target holds now, each collection once. */
export function planUpdate(
  db: Executor,
  input: UpdateTargetInput,
  types: Types = catalogTypes(db),
): UpdatePlan {
  if (input.target === 'collection') {
    if (!UUID.test(input.id) || !savedIds(db, [input.id]).size)
      throw new AppError('not_found')
    return {
      target: 'collection',
      targetId: input.id,
      name: '',
      collectionIds: [input.id],
    }
  }
  if (input.target === 'folder') {
    const folder = UUID.test(input.id)
      ? db.select().from(folders).where(eq(folders.id, input.id)).get()
      : undefined
    if (!folder) throw new AppError('not_found')
    // Posts there only through an account the update covers come with it.
    const { filter, extra } = folderSelection(db, types, folder)
    const ids = updateSelection(db, filter, MAX_FOLDER + 1, extra)
    if (ids.length > MAX_FOLDER)
      throw new AppError(
        'invalid_request',
        `收藏夹内容过多，一次最多更新 ${MAX_FOLDER} 项`,
      )
    if (!ids.length) throw new AppError('invalid_request', '收藏夹是空的')
    return {
      target: 'folder',
      targetId: folder.id,
      name: folder.name,
      collectionIds: ids,
      key: folderKey(db, folder),
    }
  }
  if (input.ids.some((id) => !UUID.test(id))) throw new AppError('unsupported')
  const unique = [...new Set(input.ids)]
  if (unique.length === 0 || unique.length > MAX_SELECTION)
    throw new AppError('unsupported')
  if (savedIds(db, unique).size !== unique.length)
    throw new AppError('not_found')
  return { target: 'many', targetId: '', name: '', collectionIds: unique }
}

/**
 * The plan, if it still holds where the update is written: its folder is
 * there under the same name and query (and the folders it names say the
 * same); a selection's collections (at most
 * 500, so read again) are all still saved. A folder's members are not read
 * again: one removed from the library since is skipped at its turn, as one
 * removed while the update runs is; one saved since is left out, as one
 * saved just after the update started would be.
 */
function holds(tx: Executor, input: UpdateTargetInput, plan?: UpdatePlan) {
  if (!plan || plan.target !== input.target) return false
  if (input.target === 'many' || input.target === 'collection')
    return (
      plan.targetId === (input.target === 'collection' ? input.id : '') &&
      savedIds(tx, plan.collectionIds).size === plan.collectionIds.length
    )
  const folder = tx
    .select({ name: folders.name, query: folders.query, tz: folders.tz })
    .from(folders)
    .where(eq(folders.id, input.id))
    .get()
  return (
    plan.targetId === input.id &&
    folder?.name === plan.name &&
    folderKey(tx, folder) === plan.key
  )
}

/** Collection kinds (`post`, `profile`) and adapters, by id. */
export function itemKinds(db: Executor, ids: string[]) {
  return new Map(
    (ids.length
      ? db
          .select({
            id: collections.id,
            kind: collections.kind,
            url: collections.url,
            adapterId: library.adapterId,
          })
          .from(collections)
          .innerJoin(library, eq(library.collectionId, collections.id))
          .where(inJson(collections.id, ids))
          .all()
      : []
    ).map((row) => [row.id, row]),
  )
}

/** The newest finished page of a profile, whose next cursor reads on. */
export function lastPage(db: Executor, collectionId: string) {
  return db
    .select()
    .from(captures)
    .where(
      and(
        eq(captures.collectionId, collectionId),
        eq(captures.isCollection, true),
        inArray(captures.state, ['complete', 'partial']),
      ),
    )
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(1)
    .get()
}

/** Whether a profile has older posts to read after its last page. */
export function hasOlder(db: Executor, collectionId: string): boolean {
  return !!lastPage(db, collectionId)?.nextPageCursor
}

/**
 * A profile's following and followers counts as its newest capture read
 * them, for the sheet to tell which lists an update would skip.
 */
function profileCounts(
  ctx: Pick<ReadContext, 'db' | 'platforms'>,
  collectionId: string,
  adapterId: string,
): { following?: number; followers?: number } {
  const pointers = ctx.platforms.countPointers()[adapterId]
  if (!pointers) return {}
  const row = ctx.db
    .select({
      metrics: captureMetrics.metrics,
      type: entities.kind,
      externalId: entities.externalId,
    })
    .from(collections)
    .innerJoin(revisions, eq(revisions.id, collections.currentRevision))
    .leftJoin(captureMetrics, eq(captureMetrics.captureId, revisions.captureId))
    .innerJoin(revisionEntities, eq(revisionEntities.revisionId, revisions.id))
    .innerJoin(
      entityVersions,
      eq(entityVersions.id, revisionEntities.entityVersionId),
    )
    .innerJoin(entities, eq(entities.id, entityVersions.entityId))
    .where(
      and(eq(collections.id, collectionId), eq(revisionEntities.isRoot, true)),
    )
    .get()
  const counts = row?.metrics?.[`${row?.type}/${row?.externalId}`]
  const read = (pointer: string) => {
    const value = counts?.[pointer]
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : undefined
  }
  const following = read(pointers.following)
  const followers = read(pointers.followers)
  return {
    ...(following === undefined ? {} : { following }),
    ...(followers === undefined ? {} : { followers }),
  }
}

export interface UpdatePreview {
  posts: number
  profiles: number
  /** Profiles whose platform can list who they follow (抓关系网). */
  listable: number
  /** The folder's name. */
  name: string
  /** A single profile: its list sizes as last captured. */
  counts?: { following?: number; followers?: number }
  /** A single profile: whether there are older posts to read. */
  older?: boolean
}

/**
 * What an update of a target would cover, for the sheet that starts it. A
 * read: the web app's dry run runs it on a read thread, where the platforms
 * are known by their count pointers (those with relation lists have them).
 */
export function previewUpdate(
  ctx: Pick<ReadContext, 'db' | 'platforms'>,
  input: UpdateTargetInput,
): UpdatePreview {
  const resolved = planUpdate(ctx.db, input, ctx.platforms.types())
  const kinds = itemKinds(ctx.db, resolved.collectionIds)
  const listing = ctx.platforms.countPointers()
  let posts = 0
  let profiles = 0
  let listable = 0
  for (const item of kinds.values()) {
    if (item.kind !== 'profile') {
      posts++
      continue
    }
    profiles++
    if (Object.hasOwn(listing, item.adapterId)) listable++
  }
  const preview: UpdatePreview = {
    posts,
    profiles,
    listable,
    name: resolved.name,
  }
  const only = kinds.get(resolved.collectionIds[0]!)
  if (resolved.target === 'collection' && only?.kind === 'profile') {
    preview.counts = profileCounts(ctx, only.id, only.adapterId)
    preview.older = hasOlder(ctx.db, only.id)
  }
  return preview
}

// --- Starting ---------------------------------------------------------------

/** The update an idempotency key started, if any. */
export function updateByKey(db: Executor, key: string): string | undefined {
  return db
    .select({ id: updates.id })
    .from(updates)
    .where(eq(updates.idemKey, key))
    .get()?.id
}

/**
 * Update a target: capture each collection it holds again, as one record.
 * Each is captured as a link submission with the same options would be;
 * `older` reads profiles on from their last page. Returns the update's id.
 *
 * What the target holds is `options.plan` when given and still holding
 * (`holds`), else read here, in the write transaction.
 */
export function startUpdate(
  ctx: CaptureContext,
  input: UpdateTargetInput,
  options: UpdateOptions = {},
): string {
  if (options.key && options.key.length > 200)
    throw new AppError('invalid_request', '请求标识过长')
  const captureOptions = options.options ?? DEFAULT_OPTIONS
  checkOptions(captureOptions)
  return ctx.db.transaction((tx) => {
    if (options.key) {
      const existing = updateByKey(tx, options.key)
      if (existing) return existing
    }
    const resolved = holds(tx, input, options.plan)
      ? options.plan!
      : planUpdate(tx, input, ctx.platforms.types())
    if (options.older) {
      const only = itemKinds(tx, resolved.collectionIds).get(
        resolved.collectionIds[0]!,
      )
      if (
        resolved.target !== 'collection' ||
        only?.kind !== 'profile' ||
        captureOptions.posts === 'none'
      )
        throw new AppError('unsupported')
      if (!hasOlder(tx, only.id)) throw new AppError('no_more_pages')
    }
    const id = newId()
    tx.insert(updates)
      .values({
        id,
        target: resolved.target,
        targetId: resolved.targetId,
        name: resolved.name,
        collectionIds: resolved.collectionIds,
        options: captureOptions,
        older: options.older ?? false,
        idemKey: options.key ?? null,
        ...(options.watchId
          ? { origin: 'watch' as const, watchId: options.watchId }
          : {}),
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .run()
    ctx.queue.enqueue(tx, 'update', id, { updateId: id })
    return id
  })
}

/**
 * Start an update as the web process does: what the target holds is read
 * first with `read` (on a read thread), unless the idempotency key already
 * started one; the write checks it still holds.
 */
export async function startPlannedUpdate(
  ctx: CaptureContext,
  input: UpdateTargetInput,
  options: Omit<UpdateOptions, 'plan'>,
  read: (input: UpdateTargetInput) => Promise<UpdatePlan>,
): Promise<string> {
  const repeated = options.key && updateByKey(ctx.db, options.key)
  return startUpdate(ctx, input, {
    ...options,
    ...(repeated ? {} : { plan: await read(input) }),
  })
}

/** What starting an update again starts: its target, as it holds now. */
export function repeatOf(
  db: Executor,
  id: string,
): { input: UpdateTargetInput; options: UpdateOptions } {
  const update = db.select().from(updates).where(eq(updates.id, id)).get()
  if (!update) throw new AppError('not_found')
  const options = { options: update.options, older: update.older }
  if (update.target === 'many')
    return {
      input: {
        target: 'many',
        ids: [...savedIds(db, update.collectionIds)],
      },
      options,
    }
  return { input: { target: update.target, id: update.targetId }, options }
}

/** Start the same update again, as a new record. */
export function repeatUpdate(ctx: CaptureContext, id: string): string {
  const { input, options } = repeatOf(ctx.db, id)
  return startUpdate(ctx, input, options)
}
