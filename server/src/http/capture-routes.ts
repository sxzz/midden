import { and, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import {
  batchProgress,
  retryRefreshBatch,
  startRefreshBatch,
  type BatchProgress,
} from '#capture/batches.ts'
import {
  captureURL,
  collectionProgress,
  librarySize,
  listRecords,
  recapture,
  recordDetail,
  recordMembers,
  recordPage,
  retryMembers,
  retryRecord,
  type CaptureMember,
  type CaptureRecord,
  type CaptureRecordDetail,
} from '#capture/records.ts'
import { stopCollection } from '#capture/related.ts'
import { captures, collections, library, submissions } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { deleteAll } from '#library/delete.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureOptions } from '#capture/options.ts'
import type { Job } from '#capture/submit.ts'

const OptionsBody = v.optional(
  v.strictObject({
    media_only: v.optional(v.boolean()),
    omit_shared: v.optional(v.boolean()),
    skip_references: v.optional(v.boolean()),
    max_posts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    since: v.optional(v.string()),
  }),
)

function captureOptions(
  input: v.InferOutput<typeof OptionsBody>,
): CaptureOptions | undefined {
  if (!input) return undefined
  return {
    ...(input.media_only ? { mediaOnly: true } : {}),
    ...(input.omit_shared ? { omitShared: true } : {}),
    ...(input.skip_references ? { skipReferences: true } : {}),
    ...(input.max_posts === undefined ? {} : { maxPosts: input.max_posts }),
    ...(input.since ? { since: input.since } : {}),
  }
}

const iso = (date: Date | null | undefined) => date?.toISOString()

function memberProgress(m: NonNullable<CaptureRecord['members']>) {
  return {
    total: m.total,
    complete: m.complete,
    partial: m.partial,
    failed: m.failed,
    pending: m.pending,
    done: m.done,
  }
}

function recordJson(r: CaptureRecord) {
  return {
    id: r.id,
    job_id: r.jobId,
    collection_id: r.collectionId,
    saved: r.saved,
    url: r.url,
    input: r.input,
    platform: r.platform,
    kind: r.kind,
    state: r.state,
    ...(r.error ? { error: r.error } : {}),
    media: r.media,
    created_at: iso(r.createdAt),
    ...(r.finishedAt ? { finished_at: iso(r.finishedAt) } : {}),
    ...(r.members ? { members: memberProgress(r.members) } : {}),
    ...(r.stopped === undefined ? {} : { stopped: r.stopped }),
    ...(r.retryable === undefined ? {} : { retryable: r.retryable }),
    ...(r.pages
      ? {
          pages: {
            more: r.pages.more,
            more_1000: r.pages.more1000,
            failed: r.pages.failed,
          },
        }
      : {}),
    done: r.done,
  }
}

function detailJson(r: CaptureRecordDetail) {
  return {
    ...recordJson(r),
    warnings: r.warnings,
    media_items: r.mediaItems.map((m) => ({
      position: m.position,
      kind: m.kind,
      ...(m.purpose ? { purpose: m.purpose } : {}),
      state: m.state,
      ...(m.error ? { error: m.error } : {}),
    })),
    reasons: r.reasons,
  }
}

function memberJson(m: CaptureMember) {
  return {
    job_id: m.jobId,
    collection_id: m.collectionId,
    saved: m.saved,
    url: m.url,
    state: m.state,
    ...(m.error ? { error: m.error } : {}),
    reasons: m.reasons,
    ...(m.gone ? { gone: true } : {}),
    created_at: iso(m.createdAt),
  }
}

/** A job, with member progress when it is a collection capture. */
export function jobJson(ctx: AccountsContext, job: Pick<Job, 'id'>) {
  const capture = ctx.db
    .select()
    .from(captures)
    .where(eq(captures.id, job.id))
    .get()
  if (!capture) throw new AppError('not_found')
  let members
  if (capture.isCollection) {
    const submission = ctx.db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.captureId, capture.id),
          ne(submissions.relatedState, 'none'),
        ),
      )
      .orderBy(desc(submissions.createdAt))
      .limit(1)
      .get()
    if (submission) {
      const progress = collectionProgress(ctx.db, submission.id)
      members = {
        ...memberProgress(progress),
        done: progress.done || progress.stopped,
      }
    }
  }
  return {
    id: capture.id,
    collection_id: capture.collectionId,
    state: capture.state,
    ...(capture.error ? { error: capture.error } : {}),
    ...(members ? { members } : {}),
  }
}

function batchJson(b: BatchProgress) {
  return {
    id: b.id,
    state: b.state,
    ...(b.error ? { error: b.error } : {}),
    total: b.total,
    submitted: b.submitted,
    reused: b.reused,
    rejected: b.rejected,
    running: b.running,
    complete: b.complete,
    partial: b.partial,
    failed: b.failed,
    members: b.members,
    retryable: b.retryable,
    done: b.done,
    active: b.active.map((item) => ({
      url: item.url,
      collection_id: item.collectionId,
      running: item.running,
      ...(item.members ? { members: item.members } : {}),
    })),
  }
}

const idempotencyKey = (c: {
  req: { header: (name: string) => string | undefined }
}) => c.req.header('Idempotency-Key') || undefined

export function captureRoutes(
  ctx: AccountsContext,
  options: { followBatch?: (batchId: string) => void } = {},
) {
  return (
    new Hono<Env>()
      .post(
        '/captures',
        json(
          v.union([
            v.strictObject({
              url: v.pipe(v.string(), v.maxLength(8192)),
              options: OptionsBody,
            }),
            v.strictObject({ refresh_id: v.string() }),
          ]),
        ),
        (c) => {
          const input = c.req.valid('json')
          const key = idempotencyKey(c)
          const job =
            'url' in input
              ? captureURL(ctx, input.url, key, captureOptions(input.options))
              : recapture(ctx, input.refresh_id, { key })
          return c.json(jobJson(ctx, job))
        },
      )

      .get('/captures', (c) => {
        const page = listRecords(ctx.db, c.req.query('cursor') || undefined)
        return c.json({
          items: page.items.map(recordJson),
          ...(page.next ? { next_cursor: page.next } : {}),
        })
      })

      .get('/captures/:id', (c) =>
        c.json(detailJson(recordDetail(ctx.db, c.req.param('id')))),
      )

      .get('/captures/:id/members', (c) => {
        const page = recordMembers(
          ctx.db,
          c.req.param('id'),
          c.req.query('state') ?? '',
          c.req.query('cursor') || undefined,
        )
        return c.json({
          items: page.items.map(memberJson),
          ...(page.next ? { next_cursor: page.next } : {}),
        })
      })

      .post('/captures/:id/retry', (c) =>
        c.json(
          jobJson(ctx, retryRecord(ctx, c.req.param('id'), idempotencyKey(c))),
        ),
      )

      .post(
        '/captures/:id/retry-failed',
        json(v.strictObject({ job_id: v.optional(v.string()) })),
        (c) => {
          const input = c.req.valid('json')
          return c.json({
            count: retryMembers(ctx, c.req.param('id'), input.job_id),
          })
        },
      )

      .post(
        '/captures/:id/pages',
        json(v.strictObject({ op: v.string() })),
        (c) => {
          const input = c.req.valid('json')
          return c.json(
            jobJson(
              ctx,
              recordPage(ctx, c.req.param('id'), input.op, idempotencyKey(c)),
            ),
          )
        },
      )

      .post('/captures/:id/stop', (c) => {
        stopCollection(ctx, c.req.param('id'))
        return c.body(null, 204)
      })

      .get('/jobs/:id', (c) => c.json(jobJson(ctx, { id: c.req.param('id') })))

      .post(
        '/refresh-batches',
        json(v.strictObject({ collection_ids: v.array(v.string()) })),
        (c) => {
          const input = c.req.valid('json')
          const batch = startRefreshBatch(ctx, input.collection_ids)
          // Started by the owner in the web app: follow it in Telegram too.
          if (c.get('session')) options.followBatch?.(batch.id)
          return c.json(batchJson(batch))
        },
      )

      .get('/refresh-batches/:id', (c) =>
        c.json(batchJson(batchProgress(ctx.db, c.req.param('id')))),
      )

      .post('/refresh-batches/:id/retry', (c) =>
        c.json({ count: retryRefreshBatch(ctx, c.req.param('id')) }),
      )

      // Whether a saved collection can be captured again. Platforms run in
      // process, so this holds for any saved collection on a known platform.
      .get('/collections/:id/availability', (c) => {
        const saved = ctx.db
          .select({ url: collections.url })
          .from(library)
          .innerJoin(collections, eq(collections.id, library.collectionId))
          .where(eq(library.collectionId, c.req.param('id')))
          .get()
        if (!saved) throw new AppError('not_found')
        let available = true
        try {
          ctx.platforms.resolve(saved.url)
        } catch {
          available = false
        }
        return c.json({ available })
      })

      .get('/library', (c) => c.json(librarySize(ctx.db)))

      .post(
        '/library/delete-all',
        json(v.strictObject({ confirm: v.literal('delete all') })),
        (c) => {
          c.req.valid('json')
          return c.json({ ...deleteAll(ctx.db), running: 0 })
        },
      )
  )
}
