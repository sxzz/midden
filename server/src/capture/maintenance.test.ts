import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterEach, describe, expect, test } from 'vitest'
import { openDatabase } from '#db/client.ts'
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
import { expectCatalogFresh } from '#testing/library.ts'
import { captureHandlers } from './handlers.ts'
import {
  collectCollections,
  collectMedia,
  failStaleCaptures,
  pruneSourceResponses,
  releaseFreePages,
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
    ).toMatchObject({ state: 'failed', error: '采集被中断' })
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
    clock.now += 71 * 60 * 60_000
    expect(pruneSourceResponses(c)).toBe(0)
    clock.now += 2 * 60 * 60_000
    expect(pruneSourceResponses(c)).toBe(1)
    // The first (a revision) and the newest stay.
    expect(c.db.select().from(sourceResponses).all()).toHaveLength(2)
    // Storage in the catalog follows the pruned responses.
    expectCatalogFresh(c)
  })

  test('free pages go back to the file system a bounded number at a time', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'midden-vacuum-'))
    const clock = { now: Date.now() }
    const open = (file: string) =>
      ({
        db: openDatabase(path.join(dir, file)),
        now: () => clock.now,
        logger: pino({ level: 'silent' }),
      }) as unknown as CaptureContext
    const c = open('new.db')
    const pages = () => ({
      total: c.db.get<{ n: number }>(
        'SELECT page_count AS n FROM pragma_page_count',
      )!.n,
      free: c.db.get<{ n: number }>(
        'SELECT freelist_count AS n FROM pragma_freelist_count',
      )!.n,
    })
    // About 6000 pages of rows, then deleted.
    c.db.$client.exec(`CREATE TABLE scratch (b BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
      INSERT INTO scratch SELECT randomblob(16000) FROM n;
      DROP TABLE scratch;`)
    const before = pages()
    expect(before.free).toBeGreaterThan(5000)
    expect(releaseFreePages(c)).toBe(4096)
    // The file shrinks by those pages, and the pointer-map pages they needed.
    expect(pages().free).toBe(before.free - 4096)
    expect(pages().total).toBeLessThanOrEqual(before.total - 4096)
    // Not again for a quarter of an hour.
    clock.now += 14 * 60_000
    expect(releaseFreePages(c)).toBe(0)
    clock.now += 2 * 60_000
    expect(releaseFreePages(c)).toBe(before.free - 4096)
    expect(pages().free).toBe(0)
    // Too few free pages to bother with.
    clock.now += 16 * 60_000
    c.db.$client.exec(`CREATE TABLE scratch (b BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
      INSERT INTO scratch SELECT randomblob(16000) FROM n;
      DROP TABLE scratch;`)
    expect(pages().free).toBeGreaterThan(300)
    expect(releaseFreePages(c)).toBe(0)
    c.db.$client.close()

    // A database made before INCREMENTAL keeps its mode: nothing to do.
    const legacy = new DatabaseSync(path.join(dir, 'old.db'))
    legacy.exec(`CREATE TABLE scratch (b BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
      INSERT INTO scratch SELECT randomblob(16000) FROM n;
      DROP TABLE scratch;`)
    legacy.close()
    const old = open('old.db')
    expect(old.db.get('SELECT * FROM pragma_auto_vacuum')).toEqual({
      auto_vacuum: 0,
    })
    expect(releaseFreePages(old)).toBe(0)
    old.db.$client.close()
  })
})
