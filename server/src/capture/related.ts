import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import { captures, collections, library, submissions } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { SnoozeError, type Job } from '#jobs/queue.ts'
import { budget, matchesOptions, storedOptions } from './options.ts'
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
 * budget lasts, the next page. The budget is soft: a page is always submitted
 * whole, since the next page starts after it and would skip what is left.
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
      submitChild({
        url: loaded.url,
        options: storedOptions(submission.captureOptions),
        key: `related-expand:${submission.id}`,
      })
    )
      finish(ctx, submission.id, capture.id)
    return
  }

  const options = storedOptions(submission.captureOptions)
  // A profile captured without its posts submits nothing from its timeline.
  if (capture.isCollection && options.posts === 'none') {
    finish(ctx, submission.id, capture.id)
    return
  }
  const limit = submission.collectionLimit
  const targets = capture.relatedTargets as StoredTarget[]
  // Timeline posts as listed, and those that passed the filters.
  let listed = 0
  let kept = 0
  const memberSubmissions: string[] = []
  for (const [index, target] of targets.entries()) {
    let member = true
    if (capture.isCollection || !options.captureReferences)
      member = !ctx.platforms.resolve(target.url).target.collection
    if (member) {
      if (capture.isCollection) {
        listed++
        if (!matchesOptions(options, target)) continue
        kept++
      } else if (!options.captureReferences) continue
    }
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
  // `max` budgets the posts it keeps; the other modes the posts listed.
  const counted = options.posts === 'max' ? kept : listed
  let more =
    capture.isCollection &&
    listed > 0 &&
    (limit === 0 ? options.posts === 'max' : limit > counted)
  let nextOptions = options
  let capped = false
  if (capture.isCollection && options.finalPage) more = false
  else if (capture.isCollection && options.posts === 'until_existing') {
    // A post saved before this page was listed: read one page more, then stop.
    if (savedBefore(ctx, memberSubmissions))
      nextOptions = { ...options, finalPage: true }
    else
      // The post cap ran out first; the page's next cursor continues it. A
      // page continued already has its next page.
      capped =
        !more &&
        !!next &&
        next !== capture.pageCursor &&
        !submission.nextSubmission
  }
  if (next && next !== capture.pageCursor && more) {
    const remaining = limit > counted ? limit - counted : 0
    const key = `batch:${submission.id}`
    const submitted = submitChild({
      url: loaded.url,
      pageCursor: next,
      pageSize: Math.min(remaining, PAGE_TARGET),
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
  finish(ctx, submission.id, capture.id, capped)
}

/**
 * Read on where the post cap stopped a timeline (`until_existing`), with the
 * run's options and a fresh cap. The page joins the run's chain, so its
 * posts belong to the same record.
 */
export function continuePages(
  ctx: CaptureContext,
  last: {
    submission: typeof submissions.$inferSelect
    capture: typeof captures.$inferSelect
  },
): SubmitJob {
  const cursor = last.capture.nextPageCursor
  if (!last.submission.timelineCapped || !cursor)
    throw new AppError('unsupported')
  const { url } = ctx.db
    .select({ url: collections.url })
    .from(collections)
    .where(eq(collections.id, last.capture.collectionId))
    .get()!
  const options = storedOptions(last.submission.captureOptions)
  const page = submit(ctx, {
    url,
    providerId: last.submission.relatedProvider,
    connectionId: last.submission.relatedConnection ?? undefined,
    parentSubmission: last.submission.id,
    pageCursor: cursor,
    ...budget(ctx, options),
    options,
    // The key runRelated would have used, had the cap not stopped it.
    key: `batch:${last.submission.id}`,
  })
  ctx.db
    .update(submissions)
    .set({ nextSubmission: page.submissionId, timelineCapped: false })
    .where(eq(submissions.id, last.submission.id))
    .run()
  return page
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

function finish(
  ctx: CaptureContext,
  submissionId: string,
  captureId: string,
  capped = false,
) {
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
      .set({ relatedState: 'complete', timelineCapped: capped })
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
