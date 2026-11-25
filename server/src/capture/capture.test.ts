import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captureMetrics,
  captures,
  captureStaging,
  collectionIdentityAliases,
  collections,
  collectionStates,
  entities,
  entityVersions,
  jobs,
  library,
  revisionEntities,
  revisions,
  submissions,
} from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  postGraph,
  type FakeFetch,
} from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(fetch: FakeFetch) {
  const handle = { current: fetch }
  ctx = testContext({
    platforms: [fakePlatform(handle)],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  return { ctx, handle }
}

async function capture(c: CaptureContext, url: string) {
  const job = submit(c, { url })
  await c.queue.drain()
  return c.db.select().from(captures).where(eq(captures.id, job.id)).get()!
}

const post = 'https://fake.test/p/1'

describe('capture and finalize', () => {
  test('a text post becomes a revision with its entities', async () => {
    const { ctx } = setup(() => ({
      text: 'hello',
      summary: 'Author：hello',
      authorName: 'Author',
      graph: postGraph('1', { text: 'hello', likes: 3 }),
    }))
    const done = await capture(ctx, post)
    expect(done).toMatchObject({ state: 'complete' })
    // Counts are kept beside the capture; what it staged is gone.
    expect(ctx.db.select().from(captureMetrics).all()).toEqual([
      { captureId: done.id, metrics: { 'fake.post/1': { '/likes': 3 } } },
    ])
    expect(ctx.db.select().from(captureStaging).all()).toEqual([])
    const revision = ctx.db.select().from(revisions).get()!
    expect(revision.captureId).toBe(done.id)
    expect(revision.payload).toMatchObject({
      text: 'hello',
      graph: { root: 'post' },
    })
    expect(ctx.db.select().from(collections).get()?.currentRevision).toBe(
      revision.id,
    )
    expect(ctx.db.select().from(entities).all()).toHaveLength(2)
    expect(ctx.db.select().from(revisionEntities).all()).toHaveLength(2)
    // Counts are kept with the capture, not in the version.
    expect(
      ctx.db.select({ data: entityVersions.data }).from(entityVersions).all(),
    ).toContainEqual({ data: { text: 'hello' } })
    // Only the related fallback queued at submit time is left.
    expect(ctx.db.select({ type: jobs.type }).from(jobs).all()).toEqual([
      { type: 'related' },
    ])
  })

  test('only content changes make a new revision', async () => {
    let body = { text: 'hello', likes: 1 }
    let author: Record<string, unknown> = { name: 'Author' }
    const { ctx } = setup(() => ({
      text: body.text,
      authorName: String(author.name),
      graph: postGraph('1', body, author),
    }))
    const refresh = async () => {
      const id = ctx.db.select().from(collections).get()!.id
      submit(ctx, { refreshId: id })
      await ctx.queue.drain()
      return ctx.db.select().from(revisions).all().length
    }
    await capture(ctx, post)
    body = { text: 'hello', likes: 99 }
    expect(await refresh()).toBe(1)
    author = { name: 'Renamed' }
    expect(await refresh()).toBe(1)
    body = { text: 'edited', likes: 99 }
    expect(await refresh()).toBe(2)
  })

  test('a gone post fails the capture; one answer marks nothing yet', async () => {
    const { ctx } = setup(() => {
      throw new FakeFailure(status.FAILED_PRECONDITION, '帖子不存在或已删除', {
        'source-state': 'deleted',
      })
    })
    const done = await capture(ctx, post)
    expect(done).toMatchObject({
      state: 'failed',
      error: '帖子不存在或已删除',
    })
    expect(ctx.db.select().from(collections).get()?.sourceState).toBeNull()
    // The answer waits for a second one, asked for an hour later.
    expect(ctx.db.select().from(collectionStates).all()).toMatchObject([
      { state: 'deleted', confirmedAt: null },
    ])
    const check = ctx.db
      .select()
      .from(jobs)
      .where(eq(jobs.type, 'source-check'))
      .get()!
    expect(check.runAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)
  })

  test('a rate limit retries at the time the platform names', async () => {
    const { ctx } = setup(() => {
      throw new FakeFailure(status.UNAVAILABLE, 'slow down', {
        'retry-after': '30',
      })
    })
    const job = submit(ctx, { url: post })
    await ctx.queue.drain()
    const row = ctx.db.select().from(jobs).where(eq(jobs.ref, job.id)).get()!
    expect(row.attempt).toBe(1)
    expect(row.runAt.getTime() - Date.now()).toBeGreaterThan(25_000)
  })

  test('nothing to keep fails the capture', async () => {
    const { ctx } = setup(() => ({ text: '' }))
    expect(await capture(ctx, post)).toMatchObject({
      state: 'failed',
      error: '没有可保存的正文或媒体',
    })
  })

  test('a mismatched identity is rejected', async () => {
    const { ctx } = setup(() => ({ externalId: '2', text: 'x' }))
    expect(await capture(ctx, post)).toMatchObject({
      state: 'failed',
      error: '平台返回的内容与链接不符',
    })
  })

  test('a profile handle moves to its stable id', async () => {
    const { ctx } = setup((req) => ({
      text: 'bio',
      canonicalTarget: {
        url: 'https://fake.test/u/42',
        platform: 'fake',
        kind: 'profile',
        objectScope: '',
        externalId: '42',
        collection: true,
        refreshOnSubmit: true,
      },
      externalId: req.externalId,
    }))
    const done = await capture(ctx, 'https://fake.test/u/someone')
    const target = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, '42'))
      .get()!
    expect(done.collectionId).toBe(target.id)
    expect(done.state).toBe('complete')
    expect(ctx.db.select().from(collectionIdentityAliases).get()).toMatchObject(
      { externalId: 'handle:someone', collectionId: target.id },
    )
    // The staging collection leaves the library; the stable one is saved.
    expect(
      ctx.db.select({ id: library.collectionId }).from(library).all(),
    ).toEqual([{ id: target.id }])

    // Through the handle again: new to the staging collection, but the
    // stable one was saved already.
    const again = submit(ctx, { url: 'https://fake.test/u/someone' })
    await ctx.queue.drain()
    const added = (id: string) =>
      ctx.db
        .select({ added: submissions.libraryAdded })
        .from(submissions)
        .where(eq(submissions.id, id))
        .get()!.added
    expect(added(again.submissionId)).toBe(false)
    const first = ctx.db
      .select({ id: submissions.id })
      .from(submissions)
      .orderBy(submissions.createdAt, submissions.id)
      .get()!
    expect(added(first.id)).toBe(true)
  })
})
