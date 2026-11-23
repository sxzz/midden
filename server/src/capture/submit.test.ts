import { randomUUIDv7 } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import {
  captures,
  collections,
  jobs,
  library,
  revisions,
  submissions,
} from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

const post = 'https://twitter.com/someone/status/123?s=20'
const profile = 'https://x.com/someone'

function queued(ctx: CaptureContext) {
  return ctx.db.select({ type: jobs.type, ref: jobs.ref }).from(jobs).all()
}

/** Pretend the capture finished with a revision. */
function complete(ctx: CaptureContext, captureId: string) {
  const capture = ctx.db
    .select()
    .from(captures)
    .where(eq(captures.id, captureId))
    .get()!
  const revisionId = randomUUIDv7()
  ctx.db
    .insert(revisions)
    .values({
      id: revisionId,
      collectionId: capture.collectionId,
      captureId,
      contentHash: 'h',
      payload: {},
      contentBytes: 2,
    })
    .run()
  ctx.db
    .update(captures)
    .set({ state: 'complete', revisionId, finishedAt: new Date() })
    .where(eq(captures.id, captureId))
    .run()
}

describe('submit', () => {
  test('saves the target and queues a capture and its related fallback', () => {
    const ctx = testContext()
    const job = submit(ctx, { url: post, key: 'a' })
    expect(job.state).toBe('queued')
    expect(job.accessScope).toBe('public')
    const collection = ctx.db.select().from(collections).get()!
    expect(collection).toMatchObject({
      platform: 'x',
      kind: 'post',
      externalId: '123',
      url: 'https://x.com/someone/status/123',
    })
    expect(ctx.db.select().from(library).get()).toMatchObject({
      collectionId: collection.id,
      providerId: 'fxtwitter',
      adapterId: 'x',
    })
    expect(queued(ctx)).toEqual([
      { type: 'capture', ref: job.id },
      { type: 'related', ref: job.submissionId },
    ])
    expect(ctx.db.select().from(submissions).get()).toMatchObject({
      input: post,
      relatedState: 'pending',
    })
  })

  test('a repeated key returns the same job; a different request conflicts', () => {
    const ctx = testContext()
    const first = submit(ctx, { url: post, key: 'a' })
    expect(submit(ctx, { url: post, key: 'a' })).toEqual(first)
    expect(() => submit(ctx, { url: profile, key: 'a' })).toThrow(
      'idempotency key conflicts',
    )
  })

  test('identical requests in flight share one capture', () => {
    const ctx = testContext()
    const first = submit(ctx, { url: post })
    const second = submit(ctx, { url: post })
    expect(second.id).toBe(first.id)
    expect(second.submissionId).not.toBe(first.submissionId)
    expect(ctx.db.select().from(captures).all()).toHaveLength(1)
  })

  test('a stored post is not fetched again; a profile always is', () => {
    const ctx = testContext()
    const first = submit(ctx, { url: post })
    complete(ctx, first.id)
    const again = submit(ctx, { url: post })
    expect(again.id).toBe(first.id)
    expect(again.state).toBe('complete')

    const page = submit(ctx, { url: profile })
    complete(ctx, page.id)
    expect(submit(ctx, { url: profile }).id).not.toBe(page.id)
  })

  test('automatic targets refetch only when older than they allow', () => {
    let now = 1_000_000
    const ctx = testContext({ now: () => now })
    const first = submit(ctx, { url: post })
    complete(ctx, first.id)
    ctx.db
      .update(collections)
      .set({ observedAt: new Date(now) })
      .run()
    const parent = submit(ctx, { url: profile })
    const child = (key: string) =>
      submit(ctx, {
        url: post,
        automatic: true,
        parentSubmission: parent.submissionId,
        refreshAfterSeconds: 60,
        key,
      })
    // Members of a collection page are always observed again.
    expect(child('member').id).not.toBe(first.id)

    const top = submit(ctx, { url: 'https://x.com/other/status/9' })
    const reference = (key: string) =>
      submit(ctx, {
        url: post,
        automatic: true,
        parentSubmission: top.submissionId,
        refreshAfterSeconds: 60,
        key,
      })
    ctx.db
      .update(captures)
      .set({ state: 'failed' })
      .where(eq(captures.automatic, true))
      .run()
    expect(reference('fresh').id).toBe(first.id)
    now += 61_000
    expect(reference('stale').id).not.toBe(first.id)
  })

  test('refresh requires a saved collection and keeps its source', () => {
    const ctx = testContext()
    expect(() => submit(ctx, { refreshId: randomUUIDv7() })).toThrow(
      'not found',
    )
    const first = submit(ctx, { url: post })
    complete(ctx, first.id)
    const refresh = submit(ctx, { refreshId: first.collectionId })
    expect(refresh.id).not.toBe(first.id)
    expect(refresh.collectionId).toBe(first.collectionId)
  })

  test('Instagram never captures anonymously', () => {
    const ctx = testContext()
    expect(() =>
      submit(ctx, { url: 'https://www.instagram.com/p/C0deabc/' }),
    ).toThrow('account required')
  })

  test('rejects unknown hosts and bad paging', () => {
    const ctx = testContext()
    expect(() => submit(ctx, { url: 'https://example.com/x' })).toThrow(
      'invalid or unsupported URL',
    )
    expect(() => submit(ctx, { url: post, pageSize: 10 })).toThrow(
      'not supported',
    )
    expect(() =>
      submit(ctx, { url: profile, options: { maxPosts: 100_001 } }),
    ).toThrow('invalid or unsupported URL')
  })

  test('options set the first page size and limit', () => {
    const ctx = testContext()
    const job = submit(ctx, { url: profile, options: { maxPosts: 250 } })
    expect(
      ctx.db.select().from(captures).where(eq(captures.id, job.id)).get(),
    ).toMatchObject({ pageSize: 100, isCollection: true })
    expect(ctx.db.select().from(submissions).get()).toMatchObject({
      collectionLimit: 250,
      captureOptions: { maxPosts: 250 },
    })
  })
})
