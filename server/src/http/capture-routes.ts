import { and, desc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { OptionsBody, optionsJson, resolveOptions } from '#capture/options.ts'
import {
  captureURL,
  captureWaits,
  collectionProgress,
  librarySize,
  recordDetail,
  recordMembers,
  recordPage,
  retryRecord,
  type CaptureMember,
  type CaptureRecord,
  type CaptureRecordDetail,
} from '#capture/records.ts'
import { stopCollection } from '#capture/related.ts'
import { captureRelations, type RelationProgress } from '#capture/relations.ts'
import { retryRecordFailed } from '#capture/retries.ts'
import { repeatOf, startPlannedUpdate } from '#capture/update-start.ts'
import {
  collectionUpdate,
  continueTimeline,
  haltUpdate,
  isUpdate,
  listRecords,
  pauseUpdate,
  previewUpdate,
  recordProfiles,
  resumeUpdate,
  stopParts,
  updateDetail,
  updateMembers,
  type ProfilePart,
  type UpdateInfo,
  type UpdateRecord,
  type UpdateRecordDetail,
  type UpdateTargetInput,
} from '#capture/updates.ts'
import { captures, collections, library, submissions } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { deleteAll } from '#library/delete.ts'
import { adminSession } from './auth.ts'
import { inline, readOnly, type NamedRead } from './offload.ts'
import { Cursor, json, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Job } from '#capture/submit.ts'
import type { Principal } from '#users/principal.ts'

/** What an update (更新) covers: a collection, a folder or a selection. */
const UpdateTargetBody = v.union([
  v.strictObject({
    target: v.picklist(['collection', 'folder']),
    id: v.string(),
  }),
  v.strictObject({
    target: v.literal('many'),
    ids: v.array(v.string()),
  }),
])

const targetInput = (
  body: v.InferOutput<typeof UpdateTargetBody>,
): UpdateTargetInput =>
  body.target === 'many'
    ? { target: 'many', ids: body.ids }
    : { target: body.target, id: body.id }

function memberProgress(m: NonNullable<CaptureRecord['members']>) {
  return {
    total: m.total,
    complete: m.complete,
    partial: m.partial,
    failed: m.failed,
    pending: m.pending,
    ...(m.known ? { known: m.known } : {}),
    done: m.done,
    ...(m.added === undefined ? {} : { added: m.added, updated: m.updated }),
  }
}

function relationJson(r: RelationProgress) {
  return {
    id: r.id,
    list: r.list,
    state: r.state,
    ...(r.expected === undefined ? {} : { expected: r.expected }),
    fetched: r.fetched,
    ...(r.error ? { error: r.error } : {}),
    ...(r.retryable ? { retryable: true } : {}),
    ...(r.rateLimited ? { rate_limited: true } : {}),
  }
}

function updateJson(u: UpdateInfo) {
  return {
    target: u.target,
    ...(u.targetId ? { target_id: u.targetId } : {}),
    ...(u.name ? { name: u.name } : {}),
    ...(u.handle ? { handle: u.handle } : {}),
    posts: u.posts,
    profiles: u.profiles,
    older: u.older,
    queued: u.queued,
    skipped: u.skipped,
    ...(u.watch ? { watch: true } : {}),
  }
}

function profilePartJson(p: ProfilePart) {
  return {
    collection_id: p.collectionId,
    url: p.url,
    ...(p.handle ? { handle: p.handle } : {}),
    ...(p.name ? { name: p.name } : {}),
    ...(p.lang ? { lang: p.lang } : {}),
    state: p.state,
    ...(p.error ? { error: p.error } : {}),
    ...(p.sourceState ? { source_state: p.sourceState } : {}),
    ...(p.jobId ? { job_id: p.jobId } : {}),
    ...(p.retryable ? { retryable: true } : {}),
    ...(p.posts
      ? {
          posts: {
            total: p.posts.total,
            finished: p.posts.finished,
            pending: p.posts.pending,
            done: p.posts.done,
            capped: p.posts.capped,
            retryable: p.posts.retryable,
            retry_id: p.posts.retryId,
            pages: p.posts.pages,
          },
        }
      : {}),
    ...(p.relations ? { relations: p.relations.map(relationJson) } : {}),
  }
}

function recordJson(r: CaptureRecord | UpdateRecord) {
  return {
    id: r.id,
    job_id: r.jobId,
    collection_id: r.collectionId,
    saved: r.saved,
    url: r.url,
    ...('handle' in r && r.handle ? { handle: r.handle } : {}),
    ...('name' in r && r.name ? { name: r.name } : {}),
    ...('lang' in r && r.lang ? { lang: r.lang } : {}),
    input: r.input,
    platform: r.platform,
    kind: r.kind,
    state: r.state,
    ...(r.waiting ? { waiting: r.waiting } : {}),
    ...(r.error ? { error: r.error } : {}),
    media: r.media,
    created_at: r.createdAt.toISOString(),
    ...(r.finishedAt ? { finished_at: r.finishedAt.toISOString() } : {}),
    ...(r.members ? { members: memberProgress(r.members) } : {}),
    ...(r.added === undefined ? {} : { added: r.added }),
    ...('sourceState' in r && r.sourceState
      ? { source_state: r.sourceState }
      : {}),
    ...(r.stopped === undefined ? {} : { stopped: r.stopped }),
    ...(r.paused ? { paused: true } : {}),
    ...(r.pausedAll ? { paused_all: true } : {}),
    retryable: r.retryable,
    ...(r.mediaRetryable ? { media_retryable: true } : {}),
    ...(r.relations ? { relations: r.relations.map(relationJson) } : {}),
    ...(r.options ? { options: optionsJson(r.options) } : {}),
    ...(r.pages
      ? {
          pages: {
            more: r.pages.more,
            more_1000: r.pages.more1000,
            capped: r.pages.capped,
            failed: r.pages.failed,
          },
        }
      : {}),
    ...('update' in r ? { update: updateJson(r.update) } : {}),
    done: r.done,
  }
}

function detailJson(
  r: CaptureRecordDetail | UpdateRecordDetail,
  profiles: ProfilePart[],
) {
  return {
    ...recordJson(r),
    ...('profiles' in r
      ? {
          profiles: r.profiles.map(profilePartJson),
          ...(r.moreProfiles ? { more_profiles: r.moreProfiles } : {}),
        }
      : profiles.length
        ? { profiles: profiles.map(profilePartJson) }
        : {}),
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
    ...(m.waiting ? { waiting: m.waiting } : {}),
    ...(m.error ? { error: m.error } : {}),
    reasons: m.reasons,
    ...(m.gone ? { gone: true } : {}),
    ...(m.retryable ? { retryable: true } : {}),
    ...(m.sourceState ? { source_state: m.sourceState } : {}),
    ...(m.list ? { list: m.list } : {}),
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.handle ? { handle: m.handle } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.lang ? { lang: m.lang } : {}),
    ...(m.libraryId ? { library_id: m.libraryId } : {}),
    created_at: m.createdAt.toISOString(),
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
  const waiting =
    capture.state === 'queued'
      ? captureWaits(ctx.db, [capture.id]).get(capture.id)
      : undefined
  const relations = captureRelations(ctx.db, capture.id)
  return {
    id: capture.id,
    collection_id: capture.collectionId,
    state: capture.state,
    ...(waiting ? { waiting } : {}),
    ...(capture.error ? { error: capture.error } : {}),
    ...(members ? { members } : {}),
    ...(relations ? { relations: relations.map(relationJson) } : {}),
  }
}

const idempotencyKey = (c: {
  req: { header: (name: string) => string | undefined }
}) => c.req.header('Idempotency-Key') || undefined

export function captureRoutes(
  ctx: AccountsContext,
  read: NamedRead,
  { dev = false }: { dev?: boolean } = {},
) {
  // An update's record as a read thread counts it, once written. Only
  // the admin writes these, and the reads are theirs.
  const recordOf = async (principal: Principal, id: string) =>
    recordJson(await read(principal, 'updateRecord', { id }))
  const plan = (principal: Principal) => (input: UpdateTargetInput) =>
    read(principal, 'updatePlan', input)
  return (
    new Hono<Env>()
      .post(
        '/captures',
        json(
          v.strictObject({
            url: v.pipe(v.string(), v.maxLength(8192)),
            options: v.optional(OptionsBody),
          }),
        ),
        (c) => {
          const input = c.req.valid('json')
          const job = captureURL(
            ctx,
            input.url,
            idempotencyKey(c),
            resolveOptions(input.options),
          )
          // A profile named by its handle is identified first: no capture
          // yet, only the record it will be.
          if (!job.collectionId)
            return c.json({
              id: job.id,
              state: job.state,
              record_id: job.submissionId,
            })
          // The record this request made, so a client can open its progress.
          return c.json({ ...jobJson(ctx, job), record_id: job.submissionId })
        },
      )

      .get('/captures', query(Cursor), (c) => {
        const page = listRecords(
          ctx.db,
          c.req.valid('query').cursor || undefined,
        )
        return c.json({
          items: page.items.map(recordJson),
          ...(page.next ? { next_cursor: page.next } : {}),
        })
      })

      .get('/captures/:id', (c) => {
        const id = c.req.param('id')
        if (isUpdate(ctx.db, id))
          return c.json(detailJson(updateDetail(ctx.db, id), []))
        const detail = recordDetail(ctx.db, id)
        return c.json(detailJson(detail, recordProfiles(ctx.db, detail)))
      })

      .get(
        '/captures/:id/members',
        query(
          v.object({
            state: v.optional(v.string()),
            cursor: v.optional(v.string()),
          }),
        ),
        (c) => {
          const input = c.req.valid('query')
          const id = c.req.param('id')
          const page = (isUpdate(ctx.db, id) ? updateMembers : recordMembers)(
            ctx.db,
            id,
            input.state ?? '',
            input.cursor || undefined,
          )
          return c.json({
            items: page.items.map(memberJson),
            ...(page.next ? { next_cursor: page.next } : {}),
          })
        },
      )

      // A new record capturing the same again; its id, to open it.
      .post('/captures/:id/retry', async (c) => {
        const id = c.req.param('id')
        if (!isUpdate(ctx.db, id))
          return c.json({
            record_id: retryRecord(ctx, id, idempotencyKey(c)).submissionId,
          })
        const { input, options } = repeatOf(ctx.db, id)
        return c.json({
          record_id: await startPlannedUpdate(
            ctx,
            input,
            options,
            plan(c.get('principal')),
          ),
        })
      })

      // Fetch again what failed, all of it or the part `id` names: a
      // member's job id, a list's or page's id, a profile's posts. What
      // failed is found on a read thread, and checked again here.
      .post(
        '/captures/:id/retry-failed',
        json(v.strictObject({ id: v.optional(v.string()) })),
        async (c) => {
          const id = c.req.param('id')
          const target = c.req.valid('json').id
          const plan = await read(c.get('principal'), 'retryPlan', {
            id,
            ...(target === undefined ? {} : { target }),
          })
          return c.json({ count: retryRecordFailed(ctx, id, target, plan) })
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

      // An update stops taking items here, then what its items still read
      // is found on a read thread and stopped here.
      .post('/captures/:id/stop', async (c) => {
        const id = c.req.param('id')
        if (isUpdate(ctx.db, id)) {
          haltUpdate(ctx, id)
          stopParts(ctx, await read(c.get('principal'), 'stopPlan', { id }))
        } else {
          stopCollection(ctx, id)
        }
        return c.body(null, 204)
      })

      // Pause or resume an update: its waiting jobs wait until it resumes.
      // Whether it is done, and its record, are counted on a read thread.
      .post('/updates/:id/pause', async (c) => {
        const id = c.req.param('id')
        const principal = c.get('principal')
        pauseUpdate(ctx, id, await read(principal, 'updateRecord', { id }))
        return c.json(await recordOf(principal, id))
      })
      .post('/updates/:id/resume', async (c) => {
        resumeUpdate(ctx, c.req.param('id'))
        return c.json(await recordOf(c.get('principal'), c.req.param('id')))
      })

      .get('/jobs/:id', (c) => c.json(jobJson(ctx, { id: c.req.param('id') })))

      .post(
        '/updates',
        json(
          v.strictObject({
            target: UpdateTargetBody,
            options: v.optional(OptionsBody),
            /** Read profiles on from their last page (抓取更早的帖子). */
            older: v.optional(v.boolean()),
          }),
        ),
        // What the target holds is read on a read thread, and the update
        // written here; its record is counted there again.
        async (c) => {
          const input = c.req.valid('json')
          const id = await startPlannedUpdate(
            ctx,
            targetInput(input.target),
            {
              options: resolveOptions(input.options),
              older: input.older,
              key: idempotencyKey(c),
            },
            plan(c.get('principal')),
          )
          return c.json(await recordOf(c.get('principal'), id))
        },
      )

      // Read on where the post cap stopped a profile's timeline.
      .post(
        '/updates/:id/continue',
        json(v.strictObject({ collection_id: v.string() })),
        // Its last page is found on a read thread.
        async (c) => {
          const id = c.req.param('id')
          const collection = c.req.valid('json').collection_id
          const plan = await read(c.get('principal'), 'continuePlan', {
            id,
            collection,
          })
          continueTimeline(ctx, id, collection, plan)
          return c.body(null, 204)
        },
      )

      // What an update would cover, for the sheet that starts it.
      .post(
        '/updates/preview',
        readOnly,
        json(v.strictObject({ target: UpdateTargetBody })),
        (c) => {
          const p = previewUpdate(ctx, targetInput(c.req.valid('json').target))
          return c.json({
            posts: p.posts,
            profiles: p.profiles,
            listable: p.listable,
            ...(p.name ? { name: p.name } : {}),
            ...(p.counts ? { counts: p.counts } : {}),
            ...(p.older === undefined ? {} : { older: p.older }),
          })
        },
      )

      // The update shown on a collection's page, and whether a profile has
      // older posts to read.
      .get('/collections/:id/update', (c) => {
        const found = collectionUpdate(ctx, c.req.param('id'))
        return c.json({
          ...(found.record ? { record: found.record } : {}),
          older: found.older,
        })
      })

      // Whether a saved collection can be captured again. Platforms run in
      // process, so this holds for any saved collection on a known platform;
      // they are this process's, so it stays here (one small read).
      .get('/collections/:id/availability', inline, (c) => {
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
        adminSession,
        json(v.strictObject({ confirm: v.literal('delete all') })),
        (c) => {
          c.req.valid('json')
          // Real data is never one request away from gone.
          if (!dev) throw new AppError('dev_only')
          return c.json({ ...deleteAll(ctx.db), running: 0 })
        },
      )
  )
}
