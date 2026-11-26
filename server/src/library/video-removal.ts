import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { pace, type CaptureContext } from '#capture/context.ts'
import { newId } from '#db/id.ts'
import { videoRemovals } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { accountPosts, type KeepReason } from './delete.ts'
import { removalEffect, removeRows, type RemovalRow } from './media-removal.ts'
import { list } from './views.ts'
import type { Executor, Transaction } from '#db/client.ts'
import type { Job } from '#jobs/queue.ts'

/**
 * What 删除所有视频 of a profile does, the same in its preview and when the
 * job plans it.
 */
export interface VideoRemovalEffect {
  /** Posts that lose videos. */
  posts: number
  /** Videos removed, each media item once. */
  videos: number
  /** Bytes their files free once nothing else uses them. */
  freed_bytes: number
  /** Removed videos whose file another media item still uses. */
  shared: number
  /**
   * Posts of the profile with videos that keep them, by the first reason
   * deleting the profile with its posts would keep them for.
   */
  kept: Record<KeepReason, number>
  /**
   * Videos of the posts that lose theirs that stay all the same: another
   * saved collection that keeps its videos has the same one, and a mark
   * would take it from that one too on its next capture.
   */
  elsewhere: number
}

export type VideoRemovalState = (typeof videoRemovals.$inferSelect)['state']

/** A removal as the API gives it. */
export interface VideoRemovalJson {
  id: string
  state: VideoRemovalState
  /** Once the job planned it. */
  effect?: VideoRemovalEffect
  /** Videos removed so far. */
  removed: number
  error?: string
  created_at: string
  finished_at?: string
}

/** Media items removed in one write transaction of the job. */
export const VIDEO_BATCH = 50

// Content videos still stored or to be stored.
const VIDEO = sql.raw(
  `a.kind = 'video' AND a.purpose = '' AND a.state <> 'removed'`,
)

/**
 * The media item of asset `a` is held by a saved collection outside
 * `going` that keeps it. Marking the item would take it from that one on
 * its next capture, and its blob stays for that one anyway.
 */
const heldElsewhere = (going: SQL) => sql`EXISTS (
  SELECT 1 FROM assets o
  JOIN captures oc ON oc.id = o.capture_id
  JOIN library ol ON ol.collection_id = oc.collection_id
  WHERE o.media_key = a.media_key AND o.state <> 'removed'
    AND oc.collection_id NOT IN (SELECT value FROM json_each(${going})))`

const COLUMNS = sql.raw(`a.id, a.capture_id, c.collection_id, a.media_key,
  a.kind, a.state, a.blob_id`)

/** A saved profile, or `not_found`. */
function checkProfile(db: Executor, id: string): void {
  const found = db.get<{ profile: number }>(sql`
    SELECT coalesce(k.root_kind LIKE '%.profile', c.kind = 'profile') AS profile
    FROM library l
    JOIN collections c ON c.id = l.collection_id
    LEFT JOIN catalog k ON k.collection_id = l.collection_id
    WHERE l.collection_id = ${id}`)
  if (!found?.profile) throw new AppError('not_found')
}

interface Plan {
  /** The posts that go when the profile goes with its posts. */
  going: string[]
  rows: RemovalRow[]
  effect: VideoRemovalEffect
}

/**
 * The videos of the profile's posts to remove: the posts deleting the
 * profile with its posts would take (`accountPosts`: those it wrote,
 * reposted or quotes, not those that only mention it, and none that
 * another saved account lists, the owner saved on its own, carries tags
 * or a note, or a saved post that stays quotes), each video in every
 * capture of them, unless another saved collection holds the same one.
 */
function plan(tx: Transaction, profileId: string): Plan {
  checkProfile(tx, profileId)
  const posts = accountPosts(tx, [profileId])
  const going = posts.filter((post) => !post.reason).map((post) => post.id)
  const goingList = list(going)
  const videos = tx.all<RemovalRow & { held: number }>(sql`
    SELECT ${COLUMNS}, ${heldElsewhere(goingList)} AS held
    FROM json_each(${goingList}) g
    CROSS JOIN captures c ON c.collection_id = g.value
    CROSS JOIN assets a ON a.capture_id = c.id
    WHERE ${VIDEO}
    ORDER BY c.collection_id, a.media_key, a.id`)
  const rows: RemovalRow[] = []
  const held = new Set<string>()
  for (const { held: isHeld, ...row } of videos)
    if (isHeld) held.add(row.media_key)
    else rows.push(row)
  // Kept posts count when they have videos to keep.
  const staying = posts.filter((post) => post.reason)
  const stayingList = list(staying.map((post) => post.id))
  const withVideos = new Set(
    tx
      .all<{ id: string }>(
        sql`
        SELECT g.value AS id FROM json_each(${stayingList}) g
        WHERE EXISTS (SELECT 1 FROM captures c
          JOIN assets a ON a.capture_id = c.id
          WHERE c.collection_id = g.value AND ${VIDEO})`,
      )
      .map((row) => row.id),
  )
  const kept: Record<KeepReason, number> = {
    listed: 0,
    saved: 0,
    annotated: 0,
    quoted: 0,
  }
  for (const post of staying) if (withVideos.has(post.id)) kept[post.reason!]++
  const effect = removalEffect(tx, rows)
  return {
    going,
    rows,
    effect: {
      posts: new Set(rows.map((row) => row.collection_id)).size,
      videos: effect.media,
      freed_bytes: effect.freed_bytes,
      shared: effect.shared,
      kept,
      elsewhere: held.size,
    },
  }
}

/** What 删除所有视频 would do now, changing nothing. */
export function previewVideoRemoval(
  ctx: Pick<CaptureContext, 'db'>,
  profileId: string,
): VideoRemovalEffect {
  return ctx.db.transaction((tx) => plan(tx, profileId).effect, {
    behavior: 'deferred',
  })
}

function toJson(row: typeof videoRemovals.$inferSelect): VideoRemovalJson {
  return {
    id: row.id,
    state: row.state,
    ...(row.effect ? { effect: row.effect } : {}),
    removed: row.removed,
    ...(row.error ? { error: row.error } : {}),
    created_at: row.createdAt.toISOString(),
    ...(row.finishedAt ? { finished_at: row.finishedAt.toISOString() } : {}),
  }
}

/**
 * Start removing the videos of a saved profile's posts (删除所有视频) as a
 * job; one already queued or running for it is the answer instead.
 */
export function startVideoRemoval(
  ctx: CaptureContext,
  profileId: string,
): VideoRemovalJson {
  return ctx.db.transaction((tx) => {
    checkProfile(tx, profileId)
    const active = tx
      .select()
      .from(videoRemovals)
      .where(
        and(
          eq(videoRemovals.collectionId, profileId),
          inArray(videoRemovals.state, ['queued', 'running']),
        ),
      )
      .get()
    if (active) return toJson(active)
    const row = tx
      .insert(videoRemovals)
      .values({
        id: newId(),
        collectionId: profileId,
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .returning()
      .get()
    ctx.queue.enqueue(tx, 'video-removal', row.id)
    return toJson(row)
  })
}

/** The newest removal of a profile's videos, if any. */
export function latestVideoRemoval(
  db: Executor,
  profileId: string,
): VideoRemovalJson | undefined {
  const row = db
    .select()
    .from(videoRemovals)
    .where(eq(videoRemovals.collectionId, profileId))
    .orderBy(desc(videoRemovals.createdAt), desc(videoRemovals.id))
    .limit(1)
    .get()
  return row && toJson(row)
}

/**
 * The media items among `keys` that the plan removes, as they are now:
 * every asset of them in the posts that go, unless something outside
 * holds the item by now. Returns how many items it removed.
 */
function removeBatch(
  ctx: CaptureContext,
  tx: Transaction,
  going: string[],
  keys: string[],
): number {
  const goingList = list(going)
  const rows = tx.all<RemovalRow>(sql`
    SELECT ${COLUMNS}
    FROM json_each(${list(keys)}) k
    CROSS JOIN assets a ON a.media_key = k.value
    CROSS JOIN captures c ON c.id = a.capture_id
    WHERE ${VIDEO}
      AND c.collection_id IN (SELECT value FROM json_each(${goingList}))
      AND NOT ${heldElsewhere(goingList)}`)
  if (rows.length) removeRows(ctx, tx, rows)
  return new Set(rows.map((row) => row.media_key)).size
}

/**
 * The job of 删除所有视频: plan once (the plan is recorded and the page
 * states it), then remove a batch of media items per write transaction,
 * all assets of one item in the same batch, pausing between batches so
 * the web process gets the write lock. Run again after a restart, it
 * plans what is left and goes on.
 */
export async function runVideoRemoval(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  const removal = ctx.db
    .select()
    .from(videoRemovals)
    .where(eq(videoRemovals.id, job.ref))
    .get()
  if (!removal || removal.state === 'complete' || removal.state === 'failed')
    return
  const { going, rows, effect } = ctx.db.transaction(
    (tx) => plan(tx, removal.collectionId),
    { behavior: 'deferred' },
  )
  if (!removal.effect)
    ctx.db
      .update(videoRemovals)
      .set({ state: 'running', effect })
      .where(eq(videoRemovals.id, removal.id))
      .run()
  // In plan order: a post's videos are mostly in the same batch.
  const keys = [...new Set(rows.map((row) => row.media_key))]
  for (let start = 0; start < keys.length; start += VIDEO_BATCH) {
    job.signal.throwIfAborted()
    ctx.db.transaction((tx) => {
      const removed = removeBatch(
        ctx,
        tx,
        going,
        keys.slice(start, start + VIDEO_BATCH),
      )
      tx.update(videoRemovals)
        .set({ removed: sql`${videoRemovals.removed} + ${removed}` })
        .where(eq(videoRemovals.id, removal.id))
        .run()
    })
    await pace(ctx)
  }
  ctx.db
    .update(videoRemovals)
    .set({
      state: 'complete',
      finishedAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .where(eq(videoRemovals.id, removal.id))
    .run()
}

/** Record that the job gave up. What it removed stays removed. */
export function failVideoRemoval(
  ctx: CaptureContext,
  id: string,
  message: string,
): void {
  ctx.db
    .update(videoRemovals)
    .set({
      state: 'failed',
      error: message,
      finishedAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .where(eq(videoRemovals.id, id))
    .run()
}
