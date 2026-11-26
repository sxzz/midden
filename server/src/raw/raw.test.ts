import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { backoffMs, retryAfterMs } from '#blob/s3.ts'
import { captureHandlers } from '#capture/handlers.ts'
import {
  collectCollections,
  pruneSourceResponses,
} from '#capture/maintenance.ts'
import { submit } from '#capture/submit.ts'
import {
  jobs,
  rawGarbage,
  rawUploadFailures,
  sourceResponses,
} from '#db/schema.ts'
import { RetryError, SnoozeError, type Job } from '#jobs/queue.ts'
import { deleteCollection } from '#library/delete.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { FakeS3 } from '#testing/fake-s3.ts'
import { rawGetCommand } from './get.ts'
import { deleteSourceResponses, sourceBody } from './responses.ts'
import { rawKey } from './store.ts'
import {
  collectRawGarbage,
  failRawUpload,
  runRawUpload,
  sweepRawUploads,
} from './upload.ts'
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
      'RAW_R2_BUCKET is not set',
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

  test('a body that does not match its hash is never stored, and left alone', async () => {
    const { c } = setup({ raw: false })
    const done = await capture(c, '1')
    c.raw = s3.rawStore()
    c.db
      .update(sourceResponses)
      .set({ sha256: 'a'.repeat(64) })
      .run()
    // The job goes on; the row is recorded so that nothing tries it again.
    await runRawUpload(c, job(done.id))
    expect(s3.requests).toEqual([])
    expect(rows(c)[0]!.body).toEqual(bodyOf('1'))
    expect(c.db.select().from(rawUploadFailures).all()).toMatchObject([
      { failures: 1, retryAt: null, error: expect.stringMatching(/hash/) },
    ])
    await runRawUpload(c, job(done.id))
    expect(s3.requests).toEqual([])
  })

  test('the same body is stored once, and its object stays while a row uses it', async () => {
    const { c, clock } = setup({ same: ['1', '2'] })
    const one = await capture(c, '1')
    const two = await capture(c, '2')
    const key = rawKey(sha(bodyOf('1', ['1'])))
    expect([...s3.objects.keys()]).toEqual([key])
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)

    deleteCollection(c.db, one.collectionId)
    expect(await collectCollections(c)).toBe(1)
    expect(c.db.select().from(rawGarbage).all()).toHaveLength(1)
    // Kept through the grace period, then kept for the other row.
    expect(await collectRawGarbage(c)).toBe(0)
    clock.now += 25 * HOUR
    expect(await collectRawGarbage(c)).toBe(0)
    expect(s3.objects.has(key)).toBe(true)
    expect(c.db.select().from(rawGarbage).all()).toEqual([])

    deleteCollection(c.db, two.collectionId)
    expect(await collectCollections(c)).toBe(1)
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

describe('the sweep', () => {
  /** Captured before the bucket was set up; their bodies are still here. */
  async function existing(ids = ['1', '2', '3'], same: string[] = []) {
    const { c, clock } = setup({ raw: false, same })
    const captured: string[] = []
    for (const id of ids) captured.push((await capture(c, id)).id)
    c.raw = s3.rawStore()
    return { c, clock, captured }
  }
  const queued = (c: CaptureContext) =>
    c.db
      .select({ ref: jobs.ref })
      .from(jobs)
      .where(eq(jobs.type, 'raw-upload'))
      .all()
      .map((row) => row.ref)
      .toSorted()

  test('queues the upload of bodies an hour old that no job moves', async () => {
    const { c, clock, captured } = await existing()
    // Newer ones have their own job from finalize.
    expect(sweepRawUploads(c)).toBe(0)
    clock.now += 61 * 60_000
    expect(sweepRawUploads(c)).toBe(3)
    expect(queued(c)).toEqual(captured.toSorted())
    // Queued already: not again.
    expect(sweepRawUploads(c)).toBe(0)
    await c.queue.drain()
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)
    expect(sweepRawUploads(c)).toBe(0)
  })

  test('a database full of bodies drains through it, each body stored once', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1))
    const { c, clock } = await existing(ids, ids.slice(0, 8))
    s3.oneWritePerKey = true
    clock.now += 61 * 60_000
    expect(sweepRawUploads(c)).toBe(12)
    await c.queue.drain()
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)
    expect(s3.requests.filter((r) => r.method === 'PUT')).toHaveLength(5)
    expect(s3.limited).toBe(0)
  })

  test('nothing is queued without a bucket', async () => {
    const { c, clock } = await existing()
    c.raw = undefined
    clock.now += 61 * 60_000
    expect(sweepRawUploads(c)).toBe(0)
    expect(queued(c)).toEqual([])
  })

  test('a job that gave up is queued again after a wait that grows', async () => {
    const { c, clock, captured } = await existing(['1'])
    clock.now += 61 * 60_000
    failRawUpload(c, captured[0]!, new Error('bucket down'))
    expect(c.db.select().from(rawUploadFailures).get()).toMatchObject({
      failures: 1,
      retryAt: new Date(clock.now + HOUR),
      error: 'bucket down',
    })
    expect(sweepRawUploads(c)).toBe(0)
    clock.now += HOUR + 1
    expect(sweepRawUploads(c)).toBe(1)
    // Gave up again: twice as long.
    c.db.delete(jobs).run()
    failRawUpload(c, captured[0]!, new Error('bucket down'))
    expect(c.db.select().from(rawUploadFailures).get()).toMatchObject({
      failures: 2,
      retryAt: new Date(clock.now + 2 * HOUR),
    })
    clock.now += HOUR
    expect(sweepRawUploads(c)).toBe(0)
    clock.now += HOUR + 1
    expect(sweepRawUploads(c)).toBe(1)
    // Stored at last: the record goes.
    await runRawUpload(c, job(captured[0]!))
    expect(rows(c)[0]!.remoteAt).toBeInstanceOf(Date)
    expect(c.db.select().from(rawUploadFailures).all()).toEqual([])
  })

  test('leaves a body that does not match its hash alone', async () => {
    const { c, clock, captured } = await existing(['1', '2'])
    const [bad] = rows(c)
    c.db
      .update(sourceResponses)
      .set({ sha256: 'b'.repeat(64) })
      .where(eq(sourceResponses.id, bad!.id))
      .run()
    clock.now += 61 * 60_000
    expect(sweepRawUploads(c)).toBe(2)
    await c.queue.drain()
    expect(c.db.select().from(rawUploadFailures).all()).toMatchObject([
      { responseId: bad!.id, retryAt: null },
    ])
    // Days later it is still not queued.
    clock.now += 10 * 24 * HOUR
    expect(sweepRawUploads(c)).toBe(0)
    expect(queued(c)).toEqual([])
    expect(captured).toContain(bad!.captureId)
  })
})

describe('raw-get', () => {
  test('lists a capture and writes a body from wherever it is', async () => {
    const { c } = setup()
    await capture(c, '1')
    const [row] = rows(c)
    expect(row!.remoteAt).toBeInstanceOf(Date)
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
    expect(written).toEqual([bodyOf('1')])
  })
})

describe('rate limits', () => {
  test('Retry-After is honoured, in seconds or as a date', () => {
    const now = Date.UTC(2026, 10, 26)
    expect(retryAfterMs('3', now)).toBe(3000)
    expect(retryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000)
    expect(retryAfterMs(null, now)).toBeUndefined()
    expect(retryAfterMs('soon', now)).toBeUndefined()
    expect(backoffMs(4, 500, 3000)).toBe(3000)
  })

  test('without it, waits grow exponentially with jitter', () => {
    expect(backoffMs(1, 500, undefined, () => 0)).toBe(250)
    expect(backoffMs(1, 500, undefined, () => 1)).toBe(750)
    expect(backoffMs(3, 500, undefined, () => 0.5)).toBe(2000)
  })

  test('jobs pause while the bucket rate-limits, without using attempts', async () => {
    const { c, clock } = setup({ raw: false })
    const done = await capture(c, '1')
    const warnings: unknown[] = []
    c.logger = {
      ...c.logger,
      warn: (...args: unknown[]) => warnings.push(args),
    } as never
    c.raw = s3.rawStore({ pauseMs: 60_000, now: () => clock.now })
    s3.rateLimitNext = 5
    const first = await runRawUpload(c, job(done.id)).catch((e) => e)
    expect(first).toBeInstanceOf(SnoozeError)
    expect(first.afterMs).toBe(60_000)
    expect(warnings).toHaveLength(1)
    // Meanwhile other jobs wait too, asking nothing.
    const asked = s3.requests.length
    const second = await runRawUpload(c, job(done.id)).catch((e) => e)
    expect(second).toBeInstanceOf(SnoozeError)
    expect(s3.requests.length).toBe(asked)
    expect(rows(c)[0]).toMatchObject({ body: bodyOf('1'), remoteAt: null })
    // A Retry-After too long to wait out in the request sets the pause.
    clock.now += 61_000
    s3.rateLimitNext = 1
    s3.retryAfter = '120'
    const third = await runRawUpload(c, job(done.id)).catch((e) => e)
    expect(third).toBeInstanceOf(SnoozeError)
    expect(third.afterMs).toBe(120_000)
    clock.now += 121_000
    await runRawUpload(c, job(done.id))
    expect(rows(c)[0]!.remoteAt).toBeInstanceOf(Date)
  })

  test('two jobs with one body store it once and record both rows', async () => {
    const { c } = setup({ raw: false, same: ['1', '2'] })
    const one = await capture(c, '1')
    const two = await capture(c, '2')
    c.raw = s3.rawStore()
    s3.oneWritePerKey = true
    await Promise.all([
      runRawUpload(c, job(one.id)),
      runRawUpload(c, job(two.id)),
    ])
    expect(s3.requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
    expect(s3.limited).toBe(0)
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)
  })

  test('a job whose body another row stored only checks the object', async () => {
    const { c } = setup({ same: ['1', '2'] })
    await capture(c, '1')
    const key = rawKey(sha(bodyOf('1', ['1'])))
    s3.requests.length = 0
    await capture(c, '2')
    expect(s3.requests.map((r) => `${r.method} ${r.key}`)).toEqual([
      `HEAD ${key}`,
    ])
    expect(rows(c).every((row) => row.remoteAt)).toBe(true)
  })
})
