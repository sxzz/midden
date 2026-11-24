import { and, eq, ne, sql } from 'drizzle-orm'
import {
  captureRunning,
  captures,
  collectionIdentityAliases,
  collections,
  library,
  submissions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { failCapture } from './lifecycle.ts'
import {
  holdsContent,
  isSaved,
  markUnreferenced,
  upsertCollection,
} from './submit.ts'
import type { Transaction } from '#db/client.ts'
import type { ResolveResponse } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

/**
 * A fetch named the object's stable identity (e.g. `handle:foo` is user
 * 12345). Move the capture onto that collection, or hand its requests to an
 * identical capture already running there.
 */
export function resolveCaptureScope(
  ctx: CaptureContext,
  tx: Transaction,
  captureId: string,
  canonical: ResolveResponse,
): void {
  const row = tx
    .select({
      capture: captures,
      collection: collections,
    })
    .from(captures)
    .innerJoin(collections, eq(collections.id, captures.collectionId))
    .where(eq(captures.id, captureId))
    .get()
  if (!row) return
  const { capture, collection: old } = row
  if (canonical.externalId === old.externalId) {
    // The same object under a new URL, e.g. a renamed profile.
    if (old.url !== canonical.url)
      tx.update(collections)
        .set({ url: canonical.url })
        .where(eq(collections.id, old.id))
        .run()
    return
  }
  const savedSource = capture.refreshFrom ?? old.id
  // Requests that saved the staging collection as new: the object may have
  // been saved under its stable identity all along.
  const added = tx
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.captureId, captureId),
        eq(submissions.libraryAdded, true),
      ),
    )
    .all()
    .map((row) => row.id)
  const target = upsertCollection(
    tx,
    {
      platform: old.platform,
      kind: old.kind,
      objectScope: old.objectScope,
      externalId: canonical.externalId,
      url: canonical.url,
    },
    capture.providerId,
  )
  tx.insert(collectionIdentityAliases)
    .values({
      platform: old.platform,
      kind: old.kind,
      objectScope: old.objectScope,
      externalId: old.externalId,
      collectionId: target,
    })
    .onConflictDoUpdate({
      target: [
        collectionIdentityAliases.platform,
        collectionIdentityAliases.kind,
        collectionIdentityAliases.objectScope,
        collectionIdentityAliases.externalId,
      ],
      set: { collectionId: target },
    })
    .run()

  const running = tx
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        eq(captures.collectionId, target),
        ne(captures.id, captureId),
        eq(captures.adapterId, capture.adapterId),
        eq(captures.providerId, capture.providerId),
        sql`coalesce(${captures.connectionId}, '') = ${capture.connectionId ?? ''}`,
        eq(captures.pageCursor, capture.pageCursor),
        eq(captures.pageSize, capture.pageSize),
        eq(captures.automatic, capture.automatic),
        captureRunning,
      ),
    )
    .get()
  if (added.length && holdsContent(tx, target))
    tx.update(submissions)
      .set({ libraryAdded: false })
      .where(inJson(submissions.id, added))
      .run()

  if (running) {
    tx.update(submissions)
      .set({ captureId: running.id })
      .where(eq(submissions.captureId, captureId))
      .run()
    failCapture(ctx, tx, captureId, '已并入同一内容正在进行的采集')
  } else {
    // A queued capture has no media or revisions yet, so it moves cleanly.
    tx.update(captures)
      .set({ collectionId: target })
      .where(eq(captures.id, captureId))
      .run()
  }

  if (isSaved(tx, savedSource))
    tx.insert(library)
      .values({
        collectionId: target,
        providerId: capture.providerId,
        connectionId: capture.connectionId,
        adapterId: capture.adapterId,
      })
      .onConflictDoUpdate({
        target: library.collectionId,
        set: {
          providerId: capture.providerId,
          connectionId: capture.connectionId,
          adapterId: capture.adapterId,
        },
      })
      .run()
  const now = new Date(ctx.now?.() ?? Date.now())
  unsaveIfEmpty(tx, old.id)
  markUnreferenced(tx, old.id, now)
  if (isSaved(tx, target))
    tx.update(collections)
      .set({ unreferencedAt: null })
      .where(eq(collections.id, target))
      .run()
  markUnreferenced(tx, target, now)
}

/** Drop a staging collection from the library; one with content stays. */
export function unsaveIfEmpty(tx: Transaction, collectionId: string): void {
  tx.delete(library)
    .where(
      and(
        eq(library.collectionId, collectionId),
        sql`EXISTS (SELECT 1 FROM ${collections} WHERE ${collections.id} = ${collectionId} AND ${collections.currentRevision} IS NULL)`,
      ),
    )
    .run()
}
