import { and, eq, inArray } from 'drizzle-orm'
import {
  assets,
  captures,
  collections,
  relationFetches,
  revisions,
  submissions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { withOrigin } from '#jobs/queue.ts'
import { loadCapture } from './lifecycle.ts'
import { storedOptions } from './options.ts'
import { dropSummaries } from './record-summaries.ts'
import {
  memberSubmissions,
  pageChains,
  recordRow,
  type Page,
} from './records.ts'
import { retryRelations } from './relations.ts'
import {
  failedPages,
  isRetryableList,
  isRetryablePage,
  missingMedia,
} from './retry-units.ts'
import { submit } from './submit.ts'
import {
  goneIds,
  isUpdate,
  itemRows,
  loadUpdate,
  retryItem,
  savedIds,
} from './updates.ts'
import type { Executor, Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

type Submission = typeof submissions.$inferSelect
type Capture = typeof captures.$inferSelect
type Listing = { submission: Submission; capture: Capture }

/** One part of a record a retry fetches again (see `retry-units.ts`). */
type Unit =
  /** An update's failed item, captured again in its place. */
  | { kind: 'item'; capture: string; item: Submission }
  /** A failed member, submitted again by its page. */
  | { kind: 'member'; capture: string; listing: string; page: string }
  /** A capture's failed media, downloaded again. */
  | { kind: 'media'; capture: string }
  /** A page whose listing was not submitted, submitted again. */
  | { kind: 'related'; page: string }
  /** A page that was not fetched, fetched again in its place. */
  | { kind: 'fetch'; page: Page; previous: Page }
  /** A list that failed or fell short, fetched again. */
  | { kind: 'list'; fetch: string }

/** A unit and the timeline it belongs to, if any. */
type Placed = Unit & { root?: string }

/**
 * Whether `id` names this unit: its capture (a member's or item's job id),
 * its page, its list fetch, or `posts:<root>` for all of a timeline's.
 */
function names(unit: Placed, id: string): boolean {
  if (unit.root && id === `posts:${unit.root}`) return true
  switch (unit.kind) {
    case 'item':
    case 'media':
      return unit.capture === id
    case 'member':
      return unit.capture === id || unit.page === id
    case 'related':
      return unit.page === id
    case 'fetch':
      return unit.page.submission.id === id
    case 'list':
      return unit.fetch === id
  }
}

/** Everything a record could retry now. */
function recordUnits(db: Executor, id: string): Placed[] {
  let own: Listing[]
  let items: Listing[] = []
  if (isUpdate(db, id)) {
    own = itemRows(db, [id])
    items = own
  } else {
    const row = recordRow(db, id)
    own = [{ submission: row.submission, capture: row.capture }]
  }
  const units: Placed[] = Array.from(
    missingMedia(
      db,
      own.map((o) => o.capture.id),
    ),
    (capture) => ({ kind: 'media', capture }),
  )

  const failedItems = items.filter((i) => i.capture.state === 'failed')
  const itemIds = failedItems.map((i) => i.capture.collectionId)
  const saved = savedIds(db, itemIds)
  const gone = goneIds(db, itemIds)
  for (const i of failedItems)
    if (saved.has(i.capture.collectionId) && !gone.has(i.capture.collectionId))
      units.push({ kind: 'item', capture: i.capture.id, item: i.submission })

  const roots = own
    .filter(
      (o) => o.capture.isCollection && o.submission.relatedState !== 'none',
    )
    .map((o) => o.submission.id)
  const chains = pageChains(db, roots)
  const rootOf = new Map<string, string>()
  const resubmit = new Set<string>()
  const later: { capture: string; root: string }[] = []
  for (const [root, pages] of chains) {
    for (const [index, page] of pages.entries()) {
      rootOf.set(page.submission.id, root)
      if (isRetryablePage(page)) resubmit.add(page.submission.id)
      if (index > 0) later.push({ capture: page.capture.id, root })
    }
    for (const failed of failedPages(pages))
      units.push(
        failed.kind === 'related'
          ? { kind: 'related', page: failed.page.submission.id, root }
          : {
              kind: 'fetch',
              page: failed.page,
              previous: pages[failed.index - 1]!,
              root,
            },
      )
  }
  const laterMissing = missingMedia(
    db,
    later.map((p) => p.capture),
  )
  for (const page of later)
    if (laterMissing.has(page.capture))
      units.push({ kind: 'media', capture: page.capture, root: page.root })

  const members = memberSubmissions(db, [...rootOf.keys()])
  const membersGone = goneIds(
    db,
    members
      .filter((m) => m.capture.state === 'failed')
      .map((m) => m.capture.collectionId),
  )
  for (const m of members) {
    const page = m.submission.parentSubmission!
    if (
      m.capture.state === 'failed' &&
      resubmit.has(page) &&
      !membersGone.has(m.capture.collectionId)
    )
      units.push({
        kind: 'member',
        capture: m.capture.id,
        listing: m.submission.id,
        page,
        root: rootOf.get(page),
      })
  }
  const membersMissing = missingMedia(
    db,
    members.map((m) => m.capture.id),
  )
  const placed = new Set<string>()
  for (const m of members)
    if (membersMissing.has(m.capture.id) && !placed.has(m.capture.id)) {
      placed.add(m.capture.id)
      units.push({
        kind: 'media',
        capture: m.capture.id,
        root: rootOf.get(m.submission.parentSubmission!),
      })
    }

  const owners = new Map(own.map((o) => [o.submission.id, o]))
  if (owners.size)
    for (const fetch of db
      .select({
        id: relationFetches.id,
        state: relationFetches.state,
        submission: relationFetches.submissionId,
      })
      .from(relationFetches)
      .where(
        and(
          inJson(relationFetches.submissionId, [...owners.keys()]),
          inArray(relationFetches.state, ['failed', 'partial']),
        ),
      )
      .all()) {
      const owner = owners.get(fetch.submission!)!
      if (
        isRetryableList(fetch.state, {
          captureState: owner.capture.state,
          stopped: owner.submission.collectionStopped,
        })
      )
        units.push({ kind: 'list', fetch: fetch.id })
    }
  return units
}

/**
 * Fetch again what failed in a record, each part on its own: all of it, or
 * what `target` names (a member's or item's job id, a list fetch, a page,
 * or `posts:<root>` for a profile's timeline). Only what failed is fetched
 * again, and what is already being retried is not a failure any more, so
 * asking twice queues nothing twice. Returns how many parts were queued.
 */
export function retryRecordFailed(
  ctx: CaptureContext,
  id: string,
  target?: string,
): number {
  // An update's retried work is the update's: its rank, and paused with it.
  try {
    return withOrigin({ updateId: isUpdate(ctx.db, id) ? id : null }, () =>
      retryUnits(ctx, id, target),
    )
  } finally {
    // After the work, so a summary written meanwhile does not outlive it.
    dropSummaries(ctx.db, [id])
  }
}

function retryUnits(
  ctx: CaptureContext,
  id: string,
  target: string | undefined,
): number {
  const units = recordUnits(ctx.db, id).filter(
    (unit) => !target || names(unit, target),
  )
  let count = 0
  const media = new Set<string>()
  const update = units.some((u) => u.kind === 'item')
    ? loadUpdate(ctx.db, id)
    : undefined
  for (const unit of units)
    switch (unit.kind) {
      case 'media':
        if (!media.has(unit.capture) && retryMedia(ctx, unit.capture)) count++
        media.add(unit.capture)
        break
      case 'item':
        if (retryItem(ctx, update!, unit.item)) count++
        break
      case 'fetch':
        if (refetchPage(ctx, unit.page, unit.previous, !!target)) count++
        break
      case 'list':
        if (retryRelations(ctx, unit.fetch)) count++
        break
    }
  count += resubmit(
    ctx,
    units.flatMap((u) => (u.kind === 'member' ? [u] : [])),
    units.flatMap((u) => (u.kind === 'related' ? [u.page] : [])),
  )
  return count
}

/**
 * Failed members are submitted again by their pages, and pages whose
 * listing failed submit it again: each page runs its `related` step anew.
 */
function resubmit(
  ctx: CaptureContext,
  members: { capture: string; listing: string; page: string }[],
  related: string[],
): number {
  if (!members.length && !related.length) return 0
  return ctx.db.transaction((tx) => {
    // Frees each member's key, so its page submits the target anew.
    for (const member of members)
      tx.update(submissions)
        .set({ idemKey: `retried:${member.listing}` })
        .where(eq(submissions.id, member.listing))
        .run()
    for (const page of new Set([...members.map((m) => m.page), ...related])) {
      tx.update(submissions)
        .set({ relatedState: 'pending', relatedError: '' })
        .where(
          and(
            eq(submissions.id, page),
            eq(submissions.collectionStopped, false),
          ),
        )
        .run()
      ctx.queue.enqueue(tx, 'related', page)
    }
    return new Set(members.map((m) => m.capture)).size + related.length
  })
}

/**
 * Fetch a failed page again in its place: the request its previous page
 * made, made again, so a later run of that page finds it as its own.
 */
function refetchPage(
  ctx: CaptureContext,
  page: Page,
  previous: Page,
  strict: boolean,
): boolean {
  const { db } = ctx
  const key = page.submission.idemKey
  db.update(submissions)
    .set({ idemKey: `retried:${page.submission.id}` })
    .where(eq(submissions.id, page.submission.id))
    .run()
  try {
    const collection = db
      .select({ url: collections.url })
      .from(collections)
      .where(eq(collections.id, page.capture.collectionId))
      .get()
    if (!collection) throw new AppError('not_found')
    const job = submit(ctx, {
      url: collection.url,
      providerId: previous.submission.relatedProvider,
      connectionId: previous.submission.relatedConnection ?? undefined,
      parentSubmission: previous.submission.id,
      pageCursor: page.capture.pageCursor,
      pageSize: page.capture.pageSize,
      collectionLimit: page.submission.collectionLimit,
      options: storedOptions(page.submission.captureOptions),
      key,
    })
    db.update(submissions)
      .set({ nextSubmission: job.submissionId })
      .where(eq(submissions.id, previous.submission.id))
      .run()
    return true
  } catch (error) {
    // Left as it was, to show and to retry later.
    db.update(submissions)
      .set({ idemKey: key })
      .where(eq(submissions.id, page.submission.id))
      .run()
    if (strict || !isAppError(error)) throw error
    return false
  }
}

/**
 * Download a finished capture's failed media again, into the same capture.
 * It runs as a capture downloading its media; finalize then settles it
 * without fetching anything (`settleRetriedMedia`). The capture whose
 * revision it shows is retried with it, since that one's media are what
 * the collection shows. Returns whether anything was queued.
 */
export function retryMedia(ctx: CaptureContext, captureId: string): boolean {
  return ctx.db.transaction((tx) => {
    const capture = loadCapture(tx, captureId)
    if (capture?.state !== 'partial' || !capture.revisionId) return false
    const owner = tx
      .select({ id: revisions.captureId })
      .from(revisions)
      .where(eq(revisions.id, capture.revisionId))
      .get()?.id
    let queued = false
    for (const id of new Set([captureId, owner ?? captureId]))
      queued = reopen(ctx, tx, id) || queued
    return queued
  })
}

function reopen(ctx: CaptureContext, tx: Transaction, id: string): boolean {
  const capture = loadCapture(tx, id)
  if (capture?.state !== 'partial' || !capture.revisionId) return false
  const failed = tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.captureId, id), eq(assets.state, 'failed')))
    .all()
  if (!failed.length) return false
  tx.update(assets)
    .set({ state: 'pending', error: '' })
    .where(and(eq(assets.captureId, id), eq(assets.state, 'failed')))
    .run()
  tx.update(captures)
    .set({ state: 'downloading' })
    .where(and(eq(captures.id, id), eq(captures.state, 'partial')))
    .run()
  for (const asset of failed) ctx.queue.enqueue(tx, 'download', asset.id)
  return true
}
