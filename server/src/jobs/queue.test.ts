import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pino } from 'pino'
import { afterEach, describe, expect, test } from 'vitest'
import { openDatabase, type Database } from '#db/client.ts'
import { jobs } from '#db/schema.ts'
import { recordingLogger } from '#testing/logs.ts'
import {
  backoff,
  JobQueue,
  PermanentError,
  RetryError,
  SnoozeError,
  type Job,
} from './queue.ts'

const logger = pino({ level: 'silent' })
let queue: JobQueue | undefined

afterEach(async () => {
  await queue?.stop()
  queue = undefined
})

function setup(
  handlers: ConstructorParameters<typeof JobQueue>[0]['handlers'],
  options: { concurrency?: Record<string, number>; now?: () => number } = {},
) {
  const db = openDatabase(':memory:')
  queue = new JobQueue({
    db,
    logger,
    handlers,
    concurrency: options.concurrency ?? { main: 2 },
    now: options.now,
    pollMs: 10,
  })
  return { db, queue }
}

function rows(db: Database) {
  return db.select().from(jobs).all()
}

describe('JobQueue', () => {
  test('runs a job and deletes it', async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
        },
      },
    })
    queue.enqueue(db, 'echo', 'a')
    queue.start()
    await queue.drain()
    expect(seen).toEqual(['a'])
    expect(rows(db)).toEqual([])
  })

  test('a job enqueued in a rolled-back transaction never runs', async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
        },
      },
    })
    queue.start()
    expect(() =>
      db.transaction((tx) => {
        queue.enqueue(tx, 'echo', 'a')
        throw new Error('abort')
      }),
    ).toThrow('abort')
    await queue.drain()
    expect(seen).toEqual([])
  })

  test('honors per-queue concurrency and priority', async () => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const work = async (job: Job) => {
      order.push(job.ref)
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    }
    const { db, queue } = setup(
      {
        normal: { queue: 'main', run: work },
        background: { queue: 'main', priority: 4, run: work },
      },
      { concurrency: { main: 1 } },
    )
    queue.enqueue(db, 'background', 'low')
    queue.enqueue(db, 'normal', 'high')
    queue.start()
    await queue.drain()
    expect(order).toEqual(['high', 'low'])
    expect(peak).toBe(1)
  })

  test('retries with backoff, then records the final failure', async () => {
    let clock = 1_000_000
    const failures: unknown[] = []
    const { db, queue } = setup(
      {
        flaky: {
          queue: 'main',
          run: async () => {
            throw new Error('boom')
          },
          fail: (_job, error) => {
            failures.push(error)
          },
        },
      },
      { now: () => clock },
    )
    queue.enqueue(db, 'flaky', 'x')
    queue.start()
    await queue.drain()
    let [row] = rows(db)
    expect(row?.attempt).toBe(1)
    expect(row?.lastError).toBe('boom')
    expect(row?.runAt.getTime()).toBe(clock + backoff(1))

    clock += backoff(1)
    await queue.drain()
    ;[row] = rows(db)
    expect(row?.attempt).toBe(2)

    clock += backoff(2)
    await queue.drain()
    expect(rows(db)).toEqual([])
    expect(failures).toHaveLength(1)
  })

  test('uses the delay a RetryError asks for', async () => {
    const clock = 5000
    const { db, queue } = setup(
      {
        limited: {
          queue: 'main',
          run: async () => {
            throw new RetryError('rate limited', 30_000)
          },
        },
      },
      { now: () => clock },
    )
    queue.enqueue(db, 'limited', 'x')
    queue.start()
    await queue.drain()
    expect(rows(db)[0]?.runAt.getTime()).toBe(clock + 30_000)
  })

  test('fails permanent errors without retrying', async () => {
    const failures: unknown[] = []
    const { db, queue } = setup({
      broken: {
        queue: 'main',
        run: async () => {
          throw new PermanentError('unsupported')
        },
        fail: (_job, error) => {
          failures.push(error)
        },
      },
    })
    queue.enqueue(db, 'broken', 'x')
    queue.start()
    await queue.drain()
    expect(rows(db)).toEqual([])
    expect(failures).toHaveLength(1)
  })

  test('requeues jobs left running by a previous process', async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
        },
      },
    })
    queue.enqueue(db, 'echo', 'orphan')
    db.update(jobs).set({ state: 'running', attempt: 1 }).run()
    queue.start()
    await queue.drain()
    expect(seen).toEqual(['orphan'])
  })

  test('stopping returns interrupted jobs without using an attempt', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const { db, queue } = setup({
      slow: {
        queue: 'main',
        run: (job) =>
          new Promise((_resolve, reject) => {
            started()
            job.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          }),
      },
    })
    queue.enqueue(db, 'slow', 'x')
    queue.start()
    await running
    await queue.stop()
    expect(rows(db)).toMatchObject([{ state: 'available', attempt: 0 }])
  })

  test('snoozing reschedules without using an attempt', async () => {
    const clock = 1000
    const { db, queue } = setup(
      {
        busy: {
          queue: 'main',
          run: async () => {
            throw new SnoozeError(500)
          },
        },
      },
      { now: () => clock },
    )
    queue.enqueue(db, 'busy', 'x')
    queue.start()
    await queue.drain()
    expect(rows(db)).toMatchObject([{ attempt: 0, runAt: new Date(1500) }])
  })

  test('a locked database delays claims; the loop keeps going', async () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-q-')),
      'q.db',
    )
    const db = openDatabase(file)
    // Fail at once instead of after the usual 5 s.
    db.$client.exec('PRAGMA busy_timeout = 0')
    const { logger: recording, entries } = recordingLogger()
    const seen: string[] = []
    queue = new JobQueue({
      db,
      logger: recording,
      handlers: {
        echo: {
          queue: 'main',
          run: async (job) => {
            seen.push(job.ref)
          },
        },
      },
      concurrency: { main: 1 },
      pollMs: 10,
    })
    queue.enqueue(db, 'echo', 'a')
    // As Litestream's forced TRUNCATE checkpoint holds it.
    const writer = new DatabaseSync(file)
    writer.exec('BEGIN IMMEDIATE')
    queue.start()
    await expect
      .poll(
        () =>
          entries.filter(
            (e) =>
              e.msg === 'claiming a job failed; trying again on the next tick',
          ).length,
      )
      .toBeGreaterThan(2)
    expect(seen).toEqual([])
    writer.exec('ROLLBACK')
    writer.close()
    await expect.poll(() => seen).toEqual(['a'])
    expect(rows(db)).toEqual([])
    db.$client.close()
  })
})
