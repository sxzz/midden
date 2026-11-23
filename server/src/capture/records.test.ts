import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, test } from 'vitest'
import { library } from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import { FakeFailure, fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import {
  collectionProgress,
  librarySize,
  listRecords,
  recordDetail,
  recordMembers,
  recordPage,
  retryMembers,
  retryRecord,
} from './records.ts'
import { submit } from './submit.ts'
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
})

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
                'post not found or deleted',
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
    submit(c, { url: 'https://fake.test/u/someone' })
    await c.queue.drain()
    const first = listRecords(c.db)
    expect(first.items).toHaveLength(30)
    expect(first.items[0]!.url).toBe('https://fake.test/u/someone')
    const second = listRecords(c.db, first.next)
    // Two posts left; profile members are not records.
    expect(second.items).toHaveLength(3)
    expect(second.next).toBeUndefined()
    expect(() => listRecords(c.db, 'bogus')).toThrow('invalid cursor')
    expect(librarySize(c.db)).toMatchObject({ records: 33, running: 0 })
  })

  test('collection records report member progress and retry failures', async () => {
    const broken = new Set(['2'])
    const c = setup(broken)
    const job = submit(c, { url: 'https://fake.test/u/someone' })
    await c.queue.drain()
    let record = listRecords(c.db).items[0]!
    expect(record.members).toMatchObject({
      total: 2,
      complete: 1,
      failed: 1,
      done: true,
    })
    expect(record.pages).toEqual({ more: true, more1000: true, failed: false })
    expect(record.retryable).toBe(1)
    expect(recordDetail(c.db, record.id).reasons).toEqual([
      { reason: 'post not found or deleted', count: 1 },
    ])
    expect(
      recordMembers(c.db, record.id, 'problem').items.map((m) => m.url),
    ).toEqual(['https://fake.test/p/2'])

    broken.clear()
    expect(retryMembers(c, record.id)).toBe(1)
    await c.queue.drain()
    record = listRecords(c.db).items[0]!
    expect(record.members).toMatchObject({ total: 2, complete: 2, failed: 0 })
    expect(record.retryable).toBe(0)
    expect(collectionProgress(c.db, job.submissionId).pages).toHaveLength(1)
  })

  test('"more" continues once; asking twice gives the same job', async () => {
    const c = setup(new Set())
    submit(c, { url: 'https://fake.test/u/someone' })
    await c.queue.drain()
    const root = listRecords(c.db).items[0]!
    const more = recordPage(c, root.id, 'more')
    expect(recordPage(c, root.id, 'more').id).toBe(more.id)
    await c.queue.drain()
    const page = listRecords(c.db).items[0]!
    expect(page.members).toMatchObject({ total: 2, complete: 2 })
    expect(page.pages?.more).toBe(false)
    expect(() => recordPage(c, page.id, 'more')).toThrow('no more pages')
    expect(() => recordPage(c, page.id, 'sideways')).toThrow('not supported')
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
  })
})
