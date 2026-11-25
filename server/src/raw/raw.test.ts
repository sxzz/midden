import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import {
  collectCollections,
  pruneSourceResponses,
} from '#capture/maintenance.ts'
import { submit } from '#capture/submit.ts'
import { rawGarbage, sourceResponses } from '#db/schema.ts'
import { PermanentError, RetryError, type Job } from '#jobs/queue.ts'
import { deleteCollection } from '#library/delete.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { FakeS3 } from '#testing/fake-s3.ts'
import { migrateRaw, rawGetCommand } from './migrate.ts'
import { deleteSourceResponses, sourceBody } from './responses.ts'
import { rawKey, type RawStore } from './store.ts'
import { collectRawGarbage, runRawUpload } from './upload.ts'
import type { CaptureContext } from '#capture/context.ts'

const HOUR = 60 * 60_000
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

let s3: FakeS3
let ctx: CaptureContext | undefined
beforeEach(async () => {
  s3 = await new FakeS3({ bucket: 'raw-private' }).start()
})
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
  await s3.stop()
})

/** Post `n`'s raw response; posts in `same` share one body. */
const bodyOf = (id: string, same: string[] = []) =>
  Buffer.from(
    JSON.stringify({
      data: { id: same.includes(id) ? 'shared' : id, text: 'x'.repeat(500) },
    }),
  )

function setup(
  options: { raw?: boolean; same?: string[]; vary?: boolean } = {},
) {
  const clock = { now: Date.now() }
  let fetches = 0
  ctx = testContext({
    now: () => clock.now,
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: `post ${req.externalId}`,
          graph: postGraph(req.externalId, {}),
          sourceResponses: [
            {
              // Varied: a response that differs from fetch to fetch while
              // the post does not.
              body: options.vary
                ? bodyOf(`${req.externalId}-${++fetches}`)
                : bodyOf(req.externalId, options.same),
              contentType: 'application/json',
              sourceUrl: `https://api.test/${req.externalId}`,
              visibility: 1,
            },
          ],
        }),
      }),
    ],
    handlers: captureHandlers,
    ...(options.raw === false ? {} : { raw: s3.rawStore() }),
  })
  ctx.queue.start()
  return { c: ctx, clock }
}

const rows = (c: CaptureContext) =>
  c.db
    .select()
    .from(sourceResponses)
    .orderBy(asc(sourceResponses.sourceUrl))
    .all()

const job = (ref: string, attempt = 1): Job => ({
  id: 1,
  type: 'raw-upload',
  ref,
  attempt,
  maxAttempts: 12,
  signal: new AbortController().signal,
})

async function capture(c: CaptureContext, id: string) {
  const done = submit(c, { url: `https://fake.test/p/${id}` })
  await c.queue.drain()
  return done
}

describe('raw responses in the bucket', () => {
  test('a finished capture moves them: stored compressed, read back, then cleared', async () => {
    const { c } = setup()
    await capture(c, '1')
    const [row] = rows(c)
    const body = bodyOf('1')
    expect(row).toMatchObject({
      sha256: sha(body),
      size: body.length,
      body: Buffer.alloc(0),
    })
    expect(row!.remoteAt).toBeInstanceOf(Date)
    const object = s3.objects.get(rawKey(sha(body)))!
    expect(object.contentType).toBe('application/zstd')
    expect(object.metadata).toEqual({
      sha256: sha(body),
      size: String(body.length),
    })
    expect(zstdDecompressSync(object.body).equals(body)).toBe(true)
    expect(object.body.length).toBeLessThan(body.length / 3)
    // Written, then read back before the body was cleared.
    expect(s3.requests.map((r) => `${r.method} ${r.key}`)).toEqual([
      `PUT ${rawKey(sha(body))}`,
      `HEAD ${rawKey(sha(body))}`,
    ])
    // Read on demand, checked against the hash.
    expect(await sourceBody(c.raw, row!)).toEqual(body)
    await expect(sourceBody(undefined, row!)).rejects.toThrow(
      'RAW_R2_BUCKET and its keys are not set',
    )
  })

  test('without the raw bucket they stay in the database, as before', async () => {
    const { c } = setup({ raw: false })
    await capture(c, '1')
    const [row] = rows(c)
    expect(row).toMatchObject({ body: bodyOf('1'), remoteAt: null })
    expect(await sourceBody(undefined, row!)).toEqual(bodyOf('1'))
    expect(s3.requests).toEqual([])
  })

  test('a failed upload is retried, and the body stays until it is stored', async () => {
    const { c } = setup({ raw: false })
    const done = await capture(c, '1')
    c.raw = s3.rawStore()
    const key = rawKey(sha(bodyOf('1')))
    s3.failKeys.add(key)
    const failed = await runRawUpload(c, job(done.id)).catch((error) => error)
    expect(failed).toBeInstanceOf(RetryError)
    expect(failed.afterMs).toBe(30_000)
    expect(rows(c)[0]).toMatchObject({ body: bodyOf('1'), remoteAt: null })
    s3.failKeys.delete(key)
    await runRawUpload(c, job(done.id, 2))
    expect(rows(c)[0]!.remoteAt).toBeInstanceOf(Date)
  })

  test('a copy that reads back wrong is not trusted', async () => {
    const { c } = setup({ raw: false })
    const done = await capture(c, '1')
    c.raw = s3.rawStore()
    s3.overwrite = { etag: '0'.repeat(32) }
    await expect(runRawUpload(c, job(done.id))).rejects.toThrow(
      /reads back wrong: ETag/,
    )
    expect(rows(c)[0]).toMatchObject({ body: bodyOf('1'), remoteAt: null })
  })

  test('a body that does not match its hash is never stored', async () => {
    const { c } = setup({ raw: false })
    const done = await capture(c, '1')
    c.raw = s3.rawStore()
    c.db
      .update(sourceResponses)
      .set({ sha256: 'a'.repeat(64) })
      .run()
    await expect(runRawUpload(c, job(done.id))).rejects.toBeInstanceOf(
      PermanentError,
    )
    expect(s3.requests).toEqual([])
    expect(rows(c)[0]!.body).toEqual(bodyOf('1'))
  })

  test('the same body is stored once, and its object stays while a row uses it', async () => {
    const { c, clock } = setup({ same: ['1', '2'] })
    const one = await capture(c, '1')
    const two = await capture(c, '2')
    const key = rawKey(sha(bodyOf('1', ['1'])))
    expect([...s3.objects.keys()]).toEqual([key])
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)

    deleteCollection(c.db, one.collectionId)
    expect(collectCollections(c)).toBe(1)
    expect(c.db.select().from(rawGarbage).all()).toHaveLength(1)
    // Kept through the grace period, then kept for the other row.
    expect(await collectRawGarbage(c)).toBe(0)
    clock.now += 25 * HOUR
    expect(await collectRawGarbage(c)).toBe(0)
    expect(s3.objects.has(key)).toBe(true)
    expect(c.db.select().from(rawGarbage).all()).toEqual([])

    deleteCollection(c.db, two.collectionId)
    expect(collectCollections(c)).toBe(1)
    clock.now += 25 * HOUR
    expect(await collectRawGarbage(c)).toBe(1)
    expect(s3.objects.size).toBe(0)
    expect(c.db.select().from(rawGarbage).all()).toEqual([])
  })

  test('pruned raw responses take their objects with them', async () => {
    const { c, clock } = setup({ vary: true })
    const first = await capture(c, '1')
    // Unchanged twice: the middle capture's raw response is superseded.
    submit(c, { refreshId: first.collectionId })
    await c.queue.drain()
    submit(c, { refreshId: first.collectionId })
    await c.queue.drain()
    expect(rows(c)).toHaveLength(3)
    expect(s3.objects.size).toBe(3)
    const middle = rawKey(sha(bodyOf('1-2')))
    clock.now += 73 * HOUR
    expect(pruneSourceResponses(c)).toBe(1)
    expect(c.db.select().from(rawGarbage).all()).toMatchObject([
      { key: sha(bodyOf('1-2')) },
    ])
    clock.now += 25 * HOUR
    expect(await collectRawGarbage(c)).toBe(1)
    expect(s3.objects.has(middle)).toBe(false)
    expect(s3.objects.size).toBe(2)
  })

  test('a deletion that fails is tried again later', async () => {
    const { c, clock } = setup()
    const done = await capture(c, '1')
    const key = rawKey(sha(bodyOf('1')))
    c.db.transaction((tx) =>
      deleteSourceResponses(tx, [done.id], new Date(clock.now)),
    )
    clock.now += 25 * HOUR
    s3.failKeys.add(key)
    await expect(collectRawGarbage(c)).rejects.toThrow('raw garbage')
    expect(c.db.select().from(rawGarbage).get()).toMatchObject({
      attempts: 1,
      retryAt: new Date(clock.now + 60_000),
    })
    s3.failKeys.delete(key)
    expect(await collectRawGarbage(c)).toBe(0)
    clock.now += 61_000
    expect(await collectRawGarbage(c)).toBe(1)
    expect(s3.objects.size).toBe(0)
  })

  test('a row deleted while its body was being stored leaves the object to collection', async () => {
    const { c, clock } = setup({ raw: false })
    const done = await capture(c, '1')
    c.raw = s3.rawStore()
    let open!: () => void
    s3.gate = new Promise((resolve) => (open = resolve))
    const uploading = runRawUpload(c, job(done.id))
    await new Promise((resolve) => setTimeout(resolve, 20))
    c.db.transaction((tx) =>
      deleteSourceResponses(tx, [done.id], new Date(clock.now)),
    )
    open()
    await uploading
    expect(rows(c)).toEqual([])
    expect(c.db.select().from(rawGarbage).all()).toHaveLength(1)
    clock.now += 25 * HOUR
    expect(await collectRawGarbage(c)).toBe(1)
    expect(s3.objects.size).toBe(0)
  })
})

describe('raw-migrate', () => {
  async function existing() {
    // Captured before the bucket was set up, more than ten minutes ago.
    const { c, clock } = setup({ raw: false, same: ['3', '4'] })
    for (const id of ['1', '2', '3', '4', '5']) await capture(c, id)
    clock.now += 11 * 60_000
    const lines: string[] = []
    const run = (raw: RawStore | undefined, options = {}) =>
      migrateRaw(c.db, raw, {
        print: (line) => lines.push(line),
        now: () => clock.now,
        ...options,
      })
    return { c, clock, run, lines }
  }

  test('a dry run reports what would move and changes nothing', async () => {
    const { c, run, lines } = await existing()
    const before = rows(c)
    const summary = await run(undefined, { dryRun: true })
    expect(summary).toMatchObject({ responses: 5, stored: 0, marked: 0 })
    expect(summary.bytes).toBe(before.reduce((n, row) => n + row.size, 0))
    expect(summary.compressed).toBeGreaterThan(0)
    expect(summary.compressed).toBeLessThan(summary.bytes / 3)
    expect(rows(c)).toEqual(before)
    expect(s3.requests).toEqual([])
    expect(lines[0]).toBe('[dry run] 5 raw responses in the database to move')
  })

  test('stores, verifies and clears in limited runs that resume', async () => {
    const { c, run } = await existing()
    const bodies = new Map(rows(c).map((row) => [row.id, row.body]))
    expect(await run(s3.rawStore(), { limit: 2 })).toMatchObject({
      responses: 2,
      stored: 2,
      marked: 2,
    })
    expect(rows(c).filter((row) => row.remoteAt)).toHaveLength(2)
    // The next run picks up the rest; two of them share one object.
    expect(await run(s3.rawStore(), { concurrency: 3 })).toMatchObject({
      responses: 3,
      stored: 3,
      marked: 3,
      failed: 0,
    })
    expect(s3.objects.size).toBe(4)
    for (const row of rows(c)) {
      expect(row.body).toEqual(Buffer.alloc(0))
      expect(await sourceBody(s3.rawStore(), row)).toEqual(bodies.get(row.id))
    }
    // Nothing is left.
    expect(await run(s3.rawStore())).toMatchObject({ responses: 0 })
  })

  test('leaves rows newer than ten minutes to the server', async () => {
    const { c, clock, run } = await existing()
    clock.now -= 11 * 60_000
    expect(await run(s3.rawStore())).toMatchObject({ responses: 0 })
    expect(rows(c).every((row) => !row.remoteAt)).toBe(true)
  })

  test('a failure leaves the body in place and is reported', async () => {
    const { c, run, lines } = await existing()
    const [first] = rows(c)
    s3.failKeys.add(rawKey(first!.sha256))
    const summary = await run(s3.rawStore())
    expect(summary).toMatchObject({ responses: 5, failed: 1, marked: 4 })
    expect(
      c.db
        .select()
        .from(sourceResponses)
        .where(eq(sourceResponses.id, first!.id))
        .get(),
    ).toMatchObject({ body: first!.body, remoteAt: null })
    expect(lines.some((line) => line.startsWith(`failed ${first!.id}`))).toBe(
      true,
    )
  })

  test('raw-get lists a capture and writes a body from wherever it is', async () => {
    const { c, run } = await existing()
    const [row] = rows(c)
    await run(s3.rawStore(), { limit: 1 })
    const printed: string[] = []
    const written: Buffer[] = []
    const out = {
      print: (line: string) => printed.push(line),
      write: (bytes: Buffer) => written.push(bytes),
    }
    expect(
      await rawGetCommand(c.db, s3.rawStore(), row!.captureId, undefined, out),
    ).toBe(0)
    expect(printed).toEqual([
      `0\tbucket\t${row!.size}\tapplication/json\t${row!.sourceUrl}`,
    ])
    expect(
      await rawGetCommand(c.db, s3.rawStore(), row!.captureId, 0, out),
    ).toBe(0)
    expect(written).toEqual([row!.body])
  })
})
