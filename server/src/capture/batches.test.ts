import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import { FakeFailure, fakePlatform, postGraph } from '#testing/fake-platform.ts'
import {
  batchProgress,
  retryRefreshBatch,
  startRefreshBatch,
} from './batches.ts'
import { captureHandlers } from './handlers.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(broken: Set<string>) {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          if (req.kind === 'profile')
            return {
              text: 'profile',
              relatedTargets: [3, 4].map((id) => ({
                url: `https://fake.test/p/${id}`,
                refreshAfterSeconds: 0,
                updatedAt: '',
                publishedAt: '',
                mediaTypes: [],
                postType: 'post',
                prefetch: Buffer.alloc(0),
              })),
            }
          if (broken.has(req.externalId))
            throw new FakeFailure(status.PERMISSION_DENIED, 'no access')
          return { text: 'post', graph: postGraph(req.externalId, {}) }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  return ctx
}

describe('refresh batches', () => {
  test('refreshes saved collections and their members', async () => {
    const broken = new Set<string>()
    const c = setup(broken)
    const ids = [
      submit(c, { url: 'https://fake.test/p/1' }).collectionId,
      submit(c, { url: 'https://fake.test/u/someone' }).collectionId,
    ]
    await c.queue.drain()
    broken.add('4')
    const started = startRefreshBatch(c, [...ids, ids[0]!])
    expect(started).toMatchObject({ total: 2, submitted: 0, done: false })
    expect(() => retryRefreshBatch(c, started.id)).toThrow('批量更新仍在进行')
    await c.queue.drain()
    const done = batchProgress(c.db, started.id)
    expect(done).toMatchObject({
      state: 'complete',
      total: 2,
      submitted: 2,
      rejected: 0,
      complete: 2,
      done: true,
      retryable: 1,
      members: {
        total: 2,
        complete: 1,
        failed: 1,
        done: true,
        // Saved by the first profile capture already.
        added: 0,
        updated: 1,
      },
      active: [],
    })
    broken.clear()
    expect(retryRefreshBatch(c, started.id)).toBe(1)
    await c.queue.drain()
    expect(batchProgress(c.db, started.id)).toMatchObject({
      retryable: 0,
      members: { complete: 2, failed: 0, added: 0, updated: 2 },
    })
  })

  test('only saved collections can be refreshed', () => {
    const c = setup(new Set())
    expect(() => startRefreshBatch(c, ['nope'])).toThrow('不支持')
    expect(() => startRefreshBatch(c, [])).toThrow('不支持')
    expect(() => startRefreshBatch(c, [randomUUIDv7()])).toThrow(
      '内容不存在或已删除',
    )
  })
})
