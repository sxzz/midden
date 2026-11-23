import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  blobs,
  captures,
  collections,
  entities,
  jobs,
  mediaGarbage,
  revisions,
  sourceResponses,
} from '#db/schema.ts'
import { deleteCollection } from '#library/delete.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import {
  collectCollections,
  collectMedia,
  failStaleCaptures,
  pruneSourceResponses,
} from './maintenance.ts'
import { submit } from './submit.ts'
import type { CaptureContext } from './context.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(clock: { now: number }, text = () => 'post') {
  ctx = testContext({
    now: () => clock.now,
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: text(),
          resources: [
            {
              url: 'https://m.test/same.jpg',
              kind: 'image',
              immutableKey: '',
              altText: '',
              sensitive: false,
              purpose: '',
            },
          ],
          graph: postGraph(req.externalId, {}, undefined, {
            resourceIndices: [0],
          }),
          sourceResponses: [
            {
              body: Buffer.from('{}'),
              contentType: 'application/json',
              sourceUrl: 'https://api.test/x',
              visibility: 1,
            },
          ],
        }),
      }),
    ],
    handlers: captureHandlers,
    fetch: async () => new Response(JPEG),
  })
  ctx.queue.start()
  return ctx
}

describe('maintenance', () => {
  test('a deleted collection is removed with what only it used', async () => {
    const clock = { now: Date.now() }
    const c = setup(clock)
    const one = submit(c, { url: 'https://fake.test/p/1' })
    const two = submit(c, { url: 'https://fake.test/p/2' })
    await c.queue.drain()
    const [blob] = c.db.select().from(blobs).all()
    expect(blob).toBeDefined()

    deleteCollection(c.db, one.collectionId)
    expect(collectCollections(c)).toBe(1)
    expect(c.db.select().from(collections).all()).toHaveLength(1)
    // The other post still uses the same image.
    expect(c.db.select().from(blobs).all()).toHaveLength(1)

    deleteCollection(c.db, two.collectionId)
    expect(collectCollections(c)).toBe(1)
    expect(c.db.select().from(revisions).all()).toEqual([])
    expect(c.db.select().from(entities).all()).toEqual([])
    expect(c.db.select().from(blobs).all()).toEqual([])
    expect(c.db.select().from(mediaGarbage).all()).toHaveLength(1)

    // Files stay through the grace period, then go.
    expect(await collectMedia(c)).toBe(0)
    expect(await c.blobs.stat(blob!.hash)).toBe(JPEG.length)
    clock.now += 25 * 60 * 60_000
    expect(await collectMedia(c)).toBe(1)
    expect(await c.blobs.stat(blob!.hash)).toBeUndefined()
    expect(c.db.select().from(mediaGarbage).all()).toEqual([])
  })

  test('a collection being captured is kept until it finishes', () => {
    const c = setup({ now: Date.now() })
    const job = submit(c, { url: 'https://fake.test/p/1' })
    deleteCollection(c.db, job.collectionId)
    expect(collectCollections(c)).toBe(0)
  })

  test('captures left without a job fail after an hour', () => {
    const clock = { now: Date.now() }
    const c = setup(clock)
    const job = submit(c, { url: 'https://fake.test/p/1' })
    c.db.delete(jobs).run()
    expect(failStaleCaptures(c)).toBe(0)
    clock.now += 61 * 60_000
    expect(failStaleCaptures(c)).toBe(1)
    expect(
      c.db.select().from(captures).where(eq(captures.id, job.id)).get(),
    ).toMatchObject({ state: 'failed', error: 'capture was interrupted' })
  })

  test('raw responses of superseded unchanged captures are pruned', async () => {
    const clock = { now: Date.now() }
    let text = 'v1'
    const c = setup(clock, () => text)
    const first = submit(c, { url: 'https://fake.test/p/1' })
    await c.queue.drain()
    const refresh = async () => {
      submit(c, { refreshId: first.collectionId })
      await c.queue.drain()
    }
    await refresh() // unchanged
    text = 'v2'
    await refresh() // new revision
    expect(c.db.select().from(sourceResponses).all()).toHaveLength(3)
    clock.now += 8 * 24 * 60 * 60_000
    expect(pruneSourceResponses(c)).toBe(1)
    // The first (a revision) and the newest stay.
    expect(c.db.select().from(sourceResponses).all()).toHaveLength(2)
  })
})
