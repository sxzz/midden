import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { jobs, library } from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import { FakeFailure, fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { DEFAULT_OPTIONS } from './options.ts'
import {
  collectionProgress,
  librarySize,
  recordDetail,
  recordMembers,
  recordPage,
  retryRecord,
} from './records.ts'
import { stopCollection } from './related.ts'
import { retryRecordFailed } from './retries.ts'
import { submit } from './submit.ts'
import { listRecords } from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const target = (id: number) => ({
  url: `https://fake.test/p/${id}`,
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '',
  mediaTypes: [],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
})

/** Its first page of two posts only. */
const firstPage = { ...DEFAULT_OPTIONS, count: 2 }

/** A profile with two pages of two posts; `broken` posts fail. */
function setup(broken: Set<string>) {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          if (req.kind === 'post') {
            if (broken.has(req.externalId))
              throw new FakeFailure(
                status.FAILED_PRECONDITION,
                '帖子不存在或已删除',
              )
            return { text: 'post', graph: postGraph(req.externalId, {}) }
          }
          const page = Number(req.pageCursor || 0)
          return {
            text: 'profile',
            relatedTargets: [target(page * 2 + 1), target(page * 2 + 2)],
            nextPageCursor: page === 0 ? '1' : '',
            maxBatchSize: 1000,
          }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  return ctx
}

describe('capture records', () => {
  test('lists top-level requests only, newest first, in pages', async () => {
    const c = setup(new Set())
    for (let i = 1; i <= 32; i++)
      submit(c, { url: `https://fake.test/p/${100 + i}` })
    submit(c, { url: 'https://fake.test/u/someone', options: firstPage })
    await c.queue.drain()
    const first = listRecords(c.db)
    expect(first.items).toHaveLength(30)
    expect(first.items[0]!.url).toBe('https://fake.test/u/someone')
    const second = listRecords(c.db, first.next)
    // Two posts left; profile members are not records.
    expect(second.items).toHaveLength(3)
    expect(second.next).toBeUndefined()
    expect(() => listRecords(c.db, 'bogus')).toThrow(
      '翻页位置无效，请刷新后重试',
    )
    expect(librarySize(c.db)).toMatchObject({ records: 33, running: 0 })
  })

  test('collection records report member progress and retry failures', async () => {
    const broken = new Set(['2'])
    const c = setup(broken)
    const job = submit(c, {
      url: 'https://fake.test/u/someone',
      options: firstPage,
    })
    await c.queue.drain()
    let record = listRecords(c.db).items[0]!
    expect(record.members).toMatchObject({
      total: 2,
      complete: 1,
      failed: 1,
      done: true,
    })
    expect(record.pages).toEqual({
      more: true,
      more1000: true,
      capped: false,
      failed: false,
    })
    // The failed member is not counted until it is saved.
    expect(record.members).toMatchObject({ added: 1, updated: 0 })
    expect(record.retryable).toBe(1)
    expect(recordDetail(c.db, record.id).reasons).toEqual([
      { reason: '帖子不存在或已删除', count: 1 },
    ])
    expect(
      recordMembers(c.db, record.id, 'problem').items.map((m) => m.url),
    ).toEqual(['https://fake.test/p/2'])
    // A failed member saved nothing: it is only a problem.
    expect(
      recordMembers(c.db, record.id, 'added').items.map((m) => m.url),
    ).toEqual(['https://fake.test/p/1'])

    broken.clear()
    expect(retryRecordFailed(c, record.id)).toBe(1)
    await c.queue.drain()
    record = listRecords(c.db).items[0]!
    expect(record.members).toMatchObject({ total: 2, complete: 2, failed: 0 })
    // The failed attempt saved nothing, so the retry still adds it.
    expect(record.members).toMatchObject({ added: 2, updated: 0 })
    expect(record.retryable).toBe(0)
    expect(collectionProgress(c.db, job.submissionId).pages).toHaveLength(1)
  })

  test('counts more members than SQLite binds values', async () => {
    const c = setup(new Set())
    const job = submit(c, {
      url: 'https://fake.test/u/someone',
      options: firstPage,
    })
    await c.queue.drain()
    // Members written directly: a profile can have tens of thousands, past
    // the 32766 values a statement can bind.
    const client = c.db.$client
    const collection = client.prepare(
      `INSERT INTO collections (id, platform, kind, external_id, url, provider_id, created_at, observed_at, source_state)
       VALUES (?, 'fake', 'post', ?, ?, 'fake', 0, 0, ?)`,
    )
    const capture = client.prepare(
      `INSERT INTO captures (id, collection_id, provider_id, adapter_id, scope, state, error, created_at)
       VALUES (?, ?, 'fake', 'fake', 'public', ?, ?, 0)`,
    )
    const member = client.prepare(
      `INSERT INTO submissions (id, capture_id, idem_key, fingerprint, input, created_at, parent_submission)
       VALUES (?, ?, ?, '', '', 0, ?)`,
    )
    const extra = 33_000
    client.exec('BEGIN')
    for (let i = 0; i < extra; i++) {
      const id = `m${i}`
      const failed = i % 3 === 0
      // Of the failed members, every tenth is gone at the source.
      collection.run(
        id,
        id,
        `https://fake.test/p/m${i}`,
        i % 30 ? null : 'deleted',
      )
      capture.run(id, id, failed ? 'failed' : 'complete', failed ? 'lost' : '')
      member.run(id, id, `related:${job.submissionId}:m${i}`, job.submissionId)
    }
    client.exec('COMMIT')

    const record = listRecords(c.db).items[0]!
    expect(record.members).toMatchObject({
      complete: 2 + 22_000,
      failed: 11_000,
      done: true,
    })
    expect(record.retryable).toBe(11_000 - 1100)
    // Members from before submissions recorded it: no guess.
    expect(record.members!.added).toBeUndefined()
    expect(record.members!.updated).toBeUndefined()
    expect(recordDetail(c.db, record.id).reasons).toEqual([
      { reason: 'lost', count: 11_000 },
    ])
    expect(recordMembers(c.db, record.id, 'failed').items).toHaveLength(50)
    // Unclassified members are neither new nor updates.
    expect(recordMembers(c.db, record.id, 'updated').items).toHaveLength(0)
    expect(
      recordMembers(c.db, record.id, 'added').items.map((m) => m.url),
    ).toEqual(['https://fake.test/p/1', 'https://fake.test/p/2'])
    expect(() => stopCollection(c, job.submissionId)).not.toThrow()
    expect(listRecords(c.db).items[0]!.stopped).toBe(true)
  })

  test('tells members new to the library from ones saved before', async () => {
    const c = setup(new Set())
    submit(c, { url: 'https://fake.test/p/1' })
    await c.queue.drain()
    expect(listRecords(c.db).items[0]).toMatchObject({ added: true })

    submit(c, { url: 'https://fake.test/u/someone', options: firstPage })
    await c.queue.drain()
    const profile = listRecords(c.db).items[0]!
    expect(profile.members).toMatchObject({ complete: 2, added: 1, updated: 1 })
    expect(profile.added).toBeUndefined()
    const urls = (filter: string) =>
      recordMembers(c.db, profile.id, filter).items.map((m) => m.url)
    expect(urls('added')).toEqual(['https://fake.test/p/2'])
    expect(urls('updated')).toEqual(['https://fake.test/p/1'])
    expect(urls('problem')).toEqual([])
    expect(() => urls('toString')).toThrow('筛选条件无效')

    submit(c, { url: 'https://fake.test/p/2' })
    await c.queue.drain()
    expect(listRecords(c.db).items[0]).toMatchObject({ added: false })
  })

  test('"more" continues once; asking twice gives the same job', async () => {
    const c = setup(new Set())
    submit(c, { url: 'https://fake.test/u/someone', options: firstPage })
    await c.queue.drain()
    const root = listRecords(c.db).items[0]!
    const more = recordPage(c, root.id, 'more')
    expect(recordPage(c, root.id, 'more').id).toBe(more.id)
    await c.queue.drain()
    const page = listRecords(c.db).items[0]!
    expect(page.members).toMatchObject({ total: 2, complete: 2 })
    expect(page.pages?.more).toBe(false)
    expect(() => recordPage(c, page.id, 'more')).toThrow('没有更多帖子了')
    expect(() => recordPage(c, page.id, 'sideways')).toThrow('不支持')
  })

  test('retrying a deleted record saves it again', async () => {
    const c = setup(new Set())
    submit(c, { url: 'https://fake.test/p/1' })
    await c.queue.drain()
    const record = listRecords(c.db).items[0]!
    c.db.delete(library).run()
    expect(listRecords(c.db).items[0]!.saved).toBe(false)
    retryRecord(c, record.id)
    expect(listRecords(c.db).items[0]!.saved).toBe(true)
    await c.queue.drain()
    expect(listRecords(c.db).items[0]!.added).toBe(true)
  })
})

describe('waiting captures', () => {
  /** Posts wait for `release`; post `flaky` hits a rate limit first. */
  function gated() {
    const gate = Promise.withResolvers<void>()
    let limited = false
    const c = testContext({
      platforms: [
        fakePlatform({
          current: async (req) => {
            if (req.kind !== 'post')
              return {
                text: 'profile',
                relatedTargets: [1, 2, 3, 4, 5, 6].map(target),
                maxBatchSize: 1000,
              }
            if (req.externalId === 'flaky' && !limited) {
              limited = true
              throw new FakeFailure(status.UNAVAILABLE, 'slow down', {
                'retry-after': '30',
              })
            }
            await gate.promise
            return { text: 'post', graph: postGraph(req.externalId, {}) }
          },
        }),
      ],
      handlers: captureHandlers,
    })
    c.queue.start()
    ctx = c
    const running = () =>
      c.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, 'capture'), eq(jobs.state, 'running')))
        .all().length
    return { c, release: () => gate.resolve(), running }
  }

  test('a capture being fetched is not waiting; one without a slot is', async () => {
    const { c, release, running } = gated()
    try {
      const first = submit(c, { url: 'https://fake.test/p/1' })
      await vi.waitFor(() => expect(running()).toBe(1))
      let record = listRecords(c.db).items[0]!
      // Still queued until the fetch is stored, but not waiting for anything.
      expect(record).toMatchObject({ jobId: first.id, state: 'queued' })
      expect(record.waiting).toBeUndefined()

      for (let i = 2; i <= 5; i++)
        submit(c, { url: `https://fake.test/p/${i}` })
      await vi.waitFor(() => expect(running()).toBe(4))
      const items = listRecords(c.db).items
      expect(items.map((r) => [r.url, r.waiting])).toEqual([
        ['https://fake.test/p/5', 'queue'],
        ['https://fake.test/p/4', undefined],
        ['https://fake.test/p/3', undefined],
        ['https://fake.test/p/2', undefined],
        ['https://fake.test/p/1', undefined],
      ])
      expect(recordDetail(c.db, items[0]!.id).waiting).toBe('queue')

      release()
      await c.queue.drain()
      record = listRecords(c.db).items[0]!
      expect(record.state).toBe('complete')
      expect(record.waiting).toBeUndefined()
    } finally {
      release()
    }
  })

  test('a capture backing off after a failure waits for its retry', async () => {
    const { c, release } = gated()
    try {
      const job = submit(c, { url: 'https://fake.test/p/flaky' })
      await vi.waitFor(() =>
        expect(
          c.db.select().from(jobs).where(eq(jobs.ref, job.id)).get(),
        ).toMatchObject({ state: 'available', attempt: 1 }),
      )
      expect(listRecords(c.db).items[0]).toMatchObject({
        state: 'queued',
        waiting: 'retry',
      })
    } finally {
      release()
    }
  })

  test('members tell waiting from being fetched', async () => {
    const { c, release, running } = gated()
    try {
      submit(c, { url: 'https://fake.test/u/someone', options: firstPage })
      await vi.waitFor(() => {
        expect(running()).toBe(4)
        expect(
          c.db.select().from(jobs).where(eq(jobs.type, 'capture')).all(),
        ).toHaveLength(6)
      })
      const record = listRecords(c.db).items[0]!
      const members = recordMembers(c.db, record.id, 'pending').items
      expect(members).toHaveLength(6)
      expect(members.every((m) => m.state === 'queued')).toBe(true)
      expect(members.filter((m) => m.waiting === 'queue')).toHaveLength(2)
    } finally {
      release()
    }
  })
})
