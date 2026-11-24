import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import { captures, collections, library, submissions } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { SnoozeError, type Job } from '#jobs/queue.ts'
import { matchesOptions, type CaptureOptions } from './options.ts'
import { unsaveIfEmpty } from './scope.ts'
import {
  isSaved,
  markUnreferenced,
  submit,
  type Job as SubmitJob,
} from './submit.ts'
import type { CaptureContext } from './context.ts'

/** A related target as stored on its capture. */
export interface StoredTarget {
  url: string
  refreshAfterSeconds: number
  updatedAt: string
  publishedAt: string
  mediaTypes: string[]
  postType: string
  /** Base64; dropped once the targets were submitted. */
  prefetch?: string
}

const PAGE_TARGET = 100

/**
 * Submit what a capture page lists (members and references) and, while the
 * budget lasts, the next page.
 */
export function runRelated(ctx: CaptureContext, job: Job): void {
  const { db } = ctx
  const loaded = db
    .select({
      submission: submissions,
      capture: captures,
      url: collections.url,
    })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .innerJoin(collections, eq(collections.id, captures.collectionId))
    .where(eq(submissions.id, job.ref))
    .get()
  if (!loaded) throw new AppError('not_found')
  const { submission, capture } = loaded
  if (submission.relatedState !== 'pending' || submission.collectionStopped)
    return
  if (capture.state === 'queued' || capture.state === 'downloading')
    throw new SnoozeError(2000)
  if (capture.state === 'failed') {
    failRelated(ctx, submission.id, '所在页面采集失败')
    return
  }
  const source = {
    providerId: submission.relatedProvider,
    connectionId: submission.relatedConnection ?? undefined,
  }

  // The capture may have moved to its canonical collection meanwhile.
  db.transaction((tx) => {
    const from = submission.relatedSourceCollection
    const current = capture.collectionId
    if ((!from || !isSaved(tx, from)) && !isSaved(tx, current))
      throw new AppError('not_found')
    if (!from || from === current) {
      return
    }

    tx.insert(library)
      .values({
        collectionId: current,
        providerId: submission.relatedProvider,
        connectionId: submission.relatedConnection,
        adapterId: submission.relatedAdapter,
      })
      .onConflictDoNothing()
      .run()
    unsaveIfEmpty(tx, from)
    markUnreferenced(tx, from, new Date(ctx.now?.() ?? Date.now()))
  })

  const submitChild = (
    input: Parameters<typeof submit>[1],
  ): SubmitJob | undefined => {
    try {
      return submit(ctx, {
        ...source,
        parentSubmission: submission.id,
        ...input,
      })
    } catch (error) {
      if (isAppError(error, 'collection_stopped')) return undefined
      throw error
    }
  }

  // An explicit request joined an automatic capture of a collection: run
  // the expanding capture it asked for instead.
  if (
    capture.automatic &&
    ctx.platforms.resolve(loaded.url).target.refreshOnSubmit
  ) {
    if (
      submitChild({ url: loaded.url, key: `related-expand:${submission.id}` })
    )
      finish(ctx, submission.id, capture.id)
    return
  }

  const options =
    (submission.captureOptions as CaptureOptions | null) ?? undefined
  // A profile updated without its posts submits nothing from its timeline.
  if (capture.isCollection && options?.skipPosts) {
    finish(ctx, submission.id, capture.id)
    return
  }
  const limit = submission.collectionLimit
  const targets = capture.relatedTargets as StoredTarget[]
  let members = 0
  const memberSubmissions: string[] = []
  for (const [index, target] of targets.entries()) {
    let member = true
    if (capture.isCollection || options?.skipReferences)
      member = !ctx.platforms.resolve(target.url).target.collection
    if (options && member) {
      if (capture.isCollection) {
        if (limit > 0 && members >= limit) continue
        if (!matchesOptions(options, target)) continue
      } else if (options.skipReferences) continue
    }
    if (member) members++
    const submitted = submitChild({
      url: target.url,
      automatic: true,
      refreshAfterSeconds: target.refreshAfterSeconds,
      prefetch: target.prefetch
        ? Buffer.from(target.prefetch, 'base64')
        : undefined,
      key: `related:${submission.id}:${index}`,
    })
    if (!submitted) return
    if (member) memberSubmissions.push(submitted.submissionId)
  }

  const next = capture.nextPageCursor
  let more = options
    ? capture.isCollection && (limit === 0 || limit > members)
    : limit > members && members > 0
  let nextOptions = options
  if (capture.isCollection && options?.finalPage) more = false
  else if (capture.isCollection && options?.untilExisting) {
    more = true
    // A post saved before this page was listed: read one page more, then stop.
    if (savedBefore(ctx, memberSubmissions)) {
      const { untilExisting: _, ...rest } = options
      nextOptions = { ...rest, finalPage: true }
    }
  }
  if (next && next !== capture.pageCursor && more) {
    const remaining = limit > members ? limit - members : 0
    const key = `batch:${submission.id}`
    const submitted = submitChild({
      url: loaded.url,
      pageCursor: next,
      pageSize: options ? Math.min(remaining, PAGE_TARGET) : remaining,
      collectionLimit: remaining,
      options: nextOptions,
      key,
    })
    if (!submitted) return
    const page = db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.idemKey, key))
      .get()
    if (page)
      db.update(submissions)
        .set({ nextSubmission: page.id })
        .where(eq(submissions.id, submission.id))
        .run()
  }
  finish(ctx, submission.id, capture.id)
}

/** Whether any of these member submissions found its post already saved. */
function savedBefore(ctx: CaptureContext, submissionIds: string[]): boolean {
  if (!submissionIds.length) return false
  return !!ctx.db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        inJson(submissions.id, submissionIds),
        eq(submissions.libraryAdded, false),
      ),
    )
    .get()
}

function finish(ctx: CaptureContext, submissionId: string, captureId: string) {
  ctx.db.transaction((tx) => {
    const capture = tx
      .select({ targets: captures.relatedTargets })
      .from(captures)
      .where(eq(captures.id, captureId))
      .get()
    if (capture)
      tx.update(captures)
        .set({
          relatedTargets: (capture.targets as StoredTarget[]).map(
            ({ prefetch: _, ...rest }) => rest,
          ),
        })
        .where(eq(captures.id, captureId))
        .run()
    tx.update(submissions)
      .set({ relatedState: 'complete' })
      .where(
        and(
          eq(submissions.id, submissionId),
          eq(submissions.relatedState, 'pending'),
          eq(submissions.collectionStopped, false),
        ),
      )
      .run()
  })
}

export function failRelated(
  ctx: CaptureContext,
  submissionId: string,
  message: string,
): void {
  ctx.db
    .update(submissions)
    .set({ relatedState: 'failed', relatedError: message })
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.relatedState, 'pending'),
      ),
    )
    .run()
}

/**
 * Stop a collection capture: no further members or pages are submitted.
 * Captures already queued still finish.
 */
export function stopCollection(
  ctx: CaptureContext,
  submissionId: string,
): void {
  ctx.db.transaction((tx) => {
    const root = tx
      .select({ isCollection: captures.isCollection })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .where(eq(submissions.id, submissionId))
      .get()
    if (!root) throw new AppError('not_found')
    if (!root.isCollection) throw new AppError('unsupported')
    const seen = new Set<string>()
    let frontier = [submissionId]
    while (frontier.length) {
      const ids = frontier.filter((id) => !seen.has(id))
      for (const id of ids) seen.add(id)
      if (!ids.length) break
      const rows = tx
        .select({ id: submissions.id, next: submissions.nextSubmission })
        .from(submissions)
        .where(inJson(submissions.id, ids))
        .all()
      const children = tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(inJson(submissions.parentSubmission, ids))
        .all()
      const pages = tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          inJson(
            submissions.idemKey,
            ids.map((id) => `batch:${id}`),
          ),
        )
        .all()
      frontier = [
        ...rows.flatMap((row) => (row.next ? [row.next] : [])),
        ...children.map((row) => row.id),
        ...pages.map((row) => row.id),
      ]
    }
    const all = [...seen]
    tx.update(submissions)
      .set({ collectionStopped: true })
      .where(inJson(submissions.id, all))
      .run()
    tx.update(submissions)
      .set({ relatedState: 'complete' })
      .where(
        and(
          inJson(submissions.id, all),
          eq(submissions.relatedState, 'pending'),
        ),
      )
      .run()
  })
}
