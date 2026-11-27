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
import { DEFAULT_OPTIONS, resolveOptions } from './options.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

const post = 'https://twitter.com/someone/status/123?s=20'
const profile = 'https://x.com/i/user/7'

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
      '与之前的请求冲突',
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
      '内容不存在或已删除',
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
    ).toThrow('此平台需要账号')
  })

  test('rejects unknown hosts and bad paging', () => {
    const ctx = testContext()
    expect(() => submit(ctx, { url: 'https://example.com/x' })).toThrow(
      '不支持的链接',
    )
    expect(() => submit(ctx, { url: post, pageSize: 10 })).toThrow('不支持')
    expect(() =>
      submit(ctx, {
        url: profile,
        options: { ...DEFAULT_OPTIONS, posts: 'max', count: 100_001 },
      }),
    ).toThrow('不支持的链接')
  })

  test('options set the first page size and limit', () => {
    const ctx = testContext({ timelineCap: 30 })
    const first = (options?: Parameters<typeof resolveOptions>[0]) => {
      const job = submit(ctx, {
        url: profile,
        ...(options ? { options: resolveOptions(options) } : {}),
      })
      const capture = ctx.db
        .select()
        .from(captures)
        .where(eq(captures.id, job.id))
        .get()!
      const submission = ctx.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, job.submissionId))
        .get()!
      // Each request its own capture.
      ctx.db
        .update(captures)
        .set({ state: 'complete' })
        .where(eq(captures.id, job.id))
        .run()
      return {
        pageSize: capture.pageSize,
        limit: submission.collectionLimit,
        options: submission.captureOptions,
      }
    }
    // None given: the defaults, the newest 100.
    expect(first()).toEqual({
      pageSize: 100,
      limit: 100,
      options: DEFAULT_OPTIONS,
    })
    expect(first({ posts: 'max', count: 250 })).toMatchObject({
      pageSize: 100,
      limit: 250,
    })
    // At most, with no number: no limit.
    expect(first({ posts: 'max' })).toMatchObject({ pageSize: 0, limit: 0 })
    expect(first({ posts: 'latest', count: 20 })).toMatchObject({
      pageSize: 20,
      limit: 20,
    })
    expect(first({ posts: 'until_existing' })).toMatchObject({
      pageSize: 30,
      limit: 30,
    })
    expect(first({ posts: 'none' })).toMatchObject({ pageSize: 0, limit: 0 })
  })

  test('a date range is fixed when the run starts, not in its fingerprint', () => {
    let now = Date.parse('2026-06-10T00:00:00Z')
    const ctx = testContext({ now: () => now })
    const options = resolveOptions({ since_days: 7 })
    const job = submit(ctx, { url: profile, options, key: 'k' })
    expect(
      ctx.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, job.submissionId))
        .get()!.captureOptions,
    ).toEqual({ ...options, since: '2026-06-03T00:00:00.000Z' })
    // A repeat of the same request a moment later is the same request.
    now += 1000
    expect(submit(ctx, { url: profile, options, key: 'k' }).submissionId).toBe(
      job.submissionId,
    )
  })

  test('options are validated with their defaults filled in', () => {
    expect(resolveOptions()).toEqual(DEFAULT_OPTIONS)
    expect(resolveOptions({ posts: 'max' })).toEqual({
      ...DEFAULT_OPTIONS,
      posts: 'max',
      count: undefined,
    })
    expect(resolveOptions({ posts: 'latest', count: 30 }).count).toBe(30)
    expect(() => resolveOptions({ posts: 'until_existing', count: 5 })).toThrow(
      '只有最新和最多可以设置条数',
    )
    expect(() => resolveOptions({ posts: 'none', count: 5 })).toThrow()
    const ctx = testContext()
    expect(() =>
      submit(ctx, {
        url: profile,
        options: { ...DEFAULT_OPTIONS, sinceDays: 3 as 1 },
      }),
    ).toThrow('不支持的链接')
  })
})
