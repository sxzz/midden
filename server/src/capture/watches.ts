import { createHash } from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  collections,
  folders,
  jobs,
  library,
  updates,
  watches,
  type WatchFrequency,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { checkOptions, type CaptureOptions } from './options.ts'
import {
  handles,
  startUpdate,
  updateRecords,
  type UpdateTargetInput,
} from './updates.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

/**
 * 定期更新: a saved profile or a folder updated on a schedule. A run is an
 * ordinary update with the watch's options, marked as the watch's, so it is
 * one capture record like any other and its jobs rank below manual work.
 *
 * Each watch runs at slots its frequency apart, from an offset of its own
 * within the interval (from its id), so watches added together do not all
 * start at once. A slot that passes while the worker is down runs once when
 * it is back, and the next slot is the next one after that moment: no run
 * per missed slot. A slot finding the watch's last run still going (or
 * paused) is skipped. At most `MAX_RUNS` watch runs go at a time; a due
 * watch beyond them waits, still due, for one to end.
 */

export const INTERVALS: Record<WatchFrequency, number> = {
  '6h': 6 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
}

/** Watch runs going at once; others wait their turn. */
export const MAX_RUNS = 2

type Watch = typeof watches.$inferSelect
export type WatchTarget = { target: 'collection' | 'folder'; id: string }

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/** Where in each interval a watch's slots fall: fixed by its id. */
export function slotOffset(id: string, frequency: WatchFrequency): number {
  // Ids made at about the same time share most of their characters: a
  // cryptographic hash spreads them evenly anyway.
  const hash = createHash('sha256').update(id).digest().readUInt32BE(0)
  return Math.floor((hash / 2 ** 32) * INTERVALS[frequency])
}

/** The watch's first slot after `now`. */
export function nextSlot(
  id: string,
  frequency: WatchFrequency,
  now: number,
): number {
  const interval = INTERVALS[frequency]
  const offset = slotOffset(id, frequency)
  return offset + (Math.floor((now - offset) / interval) + 1) * interval
}

const clock = (ctx: CaptureContext) => ctx.now?.() ?? Date.now()

const inputOf = (watch: Watch): UpdateTargetInput =>
  watch.collectionId
    ? { target: 'collection', id: watch.collectionId }
    : { target: 'folder', id: watch.folderId! }

/** A watch's target must be a saved profile or a folder. */
function checkTarget(db: Executor, target: WatchTarget): void {
  if (!UUID.test(target.id)) throw new AppError('not_found')
  if (target.target === 'folder') {
    if (!db.select().from(folders).where(eq(folders.id, target.id)).get())
      throw new AppError('not_found')
    return
  }
  const saved = db
    .select({ kind: collections.kind })
    .from(library)
    .innerJoin(collections, eq(collections.id, library.collectionId))
    .where(eq(library.collectionId, target.id))
    .get()
  if (!saved) throw new AppError('not_found')
  if (saved.kind !== 'profile')
    throw new AppError('unsupported', '只能定期更新账号或收藏夹')
}

const targetWhere = (target: WatchTarget) =>
  eq(
    target.target === 'folder' ? watches.folderId : watches.collectionId,
    target.id,
  )

/**
 * Watch a target, or change how its watch runs: one watch per target. A new
 * frequency starts from its next slot.
 */
export function setWatch(
  ctx: CaptureContext,
  target: WatchTarget,
  input: { frequency: WatchFrequency; options: CaptureOptions },
): string {
  checkOptions(input.options)
  const now = clock(ctx)
  return ctx.db.transaction((tx) => {
    checkTarget(tx, target)
    const existing = tx.select().from(watches).where(targetWhere(target)).get()
    if (existing) {
      tx.update(watches)
        .set({
          frequency: input.frequency,
          options: input.options,
          ...(existing.frequency === input.frequency
            ? {}
            : {
                nextRunAt: new Date(
                  nextSlot(existing.id, input.frequency, now),
                ),
              }),
        })
        .where(eq(watches.id, existing.id))
        .run()
      return existing.id
    }
    const id = newId()
    tx.insert(watches)
      .values({
        id,
        collectionId: target.target === 'collection' ? target.id : null,
        folderId: target.target === 'folder' ? target.id : null,
        frequency: input.frequency,
        options: input.options,
        nextRunAt: new Date(nextSlot(id, input.frequency, now)),
        createdAt: new Date(now),
      })
      .run()
    return id
  })
}

/** Change a watch: its frequency, options, or whether it runs. */
export function editWatch(
  ctx: CaptureContext,
  id: string,
  input: {
    frequency?: WatchFrequency
    options?: CaptureOptions
    enabled?: boolean
  },
): void {
  if (input.options) checkOptions(input.options)
  const now = clock(ctx)
  ctx.db.transaction((tx) => {
    const watch = tx.select().from(watches).where(eq(watches.id, id)).get()
    if (!watch) throw new AppError('not_found')
    const frequency = input.frequency ?? watch.frequency
    // From the next slot, not from one long past.
    const restart =
      frequency !== watch.frequency || (input.enabled && !watch.enabled)
    tx.update(watches)
      .set({
        frequency,
        ...(input.options ? { options: input.options } : {}),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(restart
          ? { nextRunAt: new Date(nextSlot(id, frequency, now)), error: '' }
          : {}),
      })
      .where(eq(watches.id, id))
      .run()
  })
}

export function deleteWatch(db: Executor, id: string): void {
  const { changes } = db.delete(watches).where(eq(watches.id, id)).run()
  if (!Number(changes)) throw new AppError('not_found')
}

/** Each watch's newest run, by watch id. */
function lastRuns(db: Executor, ids: string[]) {
  if (!ids.length) return new Map<string, typeof updates.$inferSelect>()
  const rows = db.all<{ id: string }>(sql`
    SELECT (SELECT u.id FROM ${updates} u WHERE u.watch_id = w.value
        ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS id
    FROM json_each(${JSON.stringify(ids)}) w`)
  const found = rows.flatMap((row) => (row.id ? [row.id] : []))
  return new Map(
    (found.length
      ? db.select().from(updates).where(inJson(updates.id, found)).all()
      : []
    ).map((row) => [row.watchId!, row]),
  )
}

/**
 * Watches whose newest run still goes: it is submitting items, is paused,
 * or has jobs left (captures, pages, lists, downloads, retries). A stopped
 * or failed run is over, whatever it left queued.
 */
function activeWatches(db: Executor): Set<string> {
  return new Set(
    db
      .all<{ id: string }>(
        sql`
      SELECT w.id FROM ${watches} w
      JOIN ${updates} u ON u.id = (SELECT id FROM ${updates}
        WHERE watch_id = w.id ORDER BY created_at DESC, id DESC LIMIT 1)
      WHERE u.state IN ('running', 'complete')
        AND (u.state = 'running' OR u.paused_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM ${jobs} j WHERE j.update_id = u.id))`,
      )
      .map((row) => row.id),
  )
}

export interface WatchTick {
  /** Watches that started a run, with the update each started. */
  started: { watchId: string; updateId: string }[]
  /** Due while their last run still went: this slot is skipped. */
  skipped: string[]
  /** Due, waiting for another watch run to end. */
  waiting: string[]
  /** Due, but their target could not be updated (an empty folder, say). */
  failed: string[]
}

/**
 * Start the runs of watches that are due, once each however many slots
 * passed. The worker calls it every minute.
 */
export function runWatches(ctx: CaptureContext): WatchTick {
  const { db } = ctx
  const now = clock(ctx)
  const tick: WatchTick = { started: [], skipped: [], waiting: [], failed: [] }
  const due = db
    .select()
    .from(watches)
    .where(
      and(eq(watches.enabled, true), lte(watches.nextRunAt, new Date(now))),
    )
    .orderBy(asc(watches.nextRunAt), asc(watches.id))
    .all()
  if (!due.length) return tick
  const active = activeWatches(db)
  let running = active.size
  const advance = (watch: Watch, error = '') =>
    db
      .update(watches)
      .set({
        nextRunAt: new Date(nextSlot(watch.id, watch.frequency, now)),
        error,
      })
      .where(eq(watches.id, watch.id))
      .run()
  for (const watch of due) {
    if (active.has(watch.id)) {
      advance(watch, watch.error)
      tick.skipped.push(watch.id)
      ctx.logger.info(
        { watchId: watch.id },
        'watch slot skipped: its last run still goes',
      )
      continue
    }
    if (running >= MAX_RUNS) {
      tick.waiting.push(watch.id)
      continue
    }
    let updateId
    try {
      updateId = startUpdate(ctx, inputOf(watch), {
        options: watch.options,
        watchId: watch.id,
      })
    } catch (error) {
      // What the owner would be told starting it by hand; the next slot
      // tries again.
      if (!isAppError(error)) throw error
      advance(watch, error.message)
      tick.failed.push(watch.id)
      ctx.logger.warn(
        { watchId: watch.id, err: error },
        'watch run not started',
      )
      continue
    }
    advance(watch)
    running++
    tick.started.push({ watchId: watch.id, updateId })
    ctx.logger.info({ watchId: watch.id, updateId }, 'watch run started')
  }
  return tick
}

export interface WatchView {
  id: string
  target: 'collection' | 'folder'
  targetId: string
  /** The folder's name. */
  name: string
  /** The profile's username and link. */
  handle: string
  url: string
  frequency: WatchFrequency
  options: CaptureOptions
  enabled: boolean
  nextRunAt: Date
  error: string
  createdAt: Date
  lastRun?: {
    id: string
    state: string
    done: boolean
    paused: boolean
    stopped: boolean
    createdAt: Date
  }
}

/** Watches, all of them, of one target or by id, oldest first. */
export function listWatches(
  db: Executor,
  only: { target?: WatchTarget; id?: string } = {},
): WatchView[] {
  const rows = db
    .select({
      watch: watches,
      folder: folders.name,
      url: collections.url,
    })
    .from(watches)
    .leftJoin(folders, eq(folders.id, watches.folderId))
    .leftJoin(collections, eq(collections.id, watches.collectionId))
    .where(
      and(
        only.target ? targetWhere(only.target) : undefined,
        only.id ? eq(watches.id, only.id) : undefined,
      ),
    )
    .orderBy(asc(watches.createdAt), asc(watches.id))
    .all()
  const ids = rows.map((row) => row.watch.id)
  const runs = lastRuns(db, ids)
  const records = new Map(
    updateRecords(db, [...runs.values()]).map((r) => [r.id, r]),
  )
  const names = handles(
    db,
    rows.flatMap((row) =>
      row.watch.collectionId ? [row.watch.collectionId] : [],
    ),
  )
  return rows.map(({ watch, folder, url }) => {
    const run = runs.get(watch.id)
    const record = run && records.get(run.id)
    return {
      id: watch.id,
      target: watch.collectionId ? 'collection' : 'folder',
      targetId: watch.collectionId ?? watch.folderId!,
      name: folder ?? '',
      handle: watch.collectionId ? (names.get(watch.collectionId) ?? '') : '',
      url: url ?? '',
      frequency: watch.frequency,
      options: watch.options,
      enabled: watch.enabled,
      nextRunAt: watch.nextRunAt,
      error: watch.error,
      createdAt: watch.createdAt,
      ...(run && record
        ? {
            lastRun: {
              id: run.id,
              state: record.state,
              done: record.done,
              paused: !!record.paused,
              stopped: !!record.stopped,
              createdAt: run.createdAt,
            },
          }
        : {}),
    }
  })
}
