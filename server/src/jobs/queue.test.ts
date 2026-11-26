import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterEach, describe, expect, test } from 'vitest'
import { openDatabase, type Database } from '#db/client.ts'
import { jobs, updates } from '#db/schema.ts'
import { recordingLogger } from '#testing/logs.ts'
import { readJobControl, writeJobControl } from './control.ts'
import {
  backoff,
  JobQueue,
  PermanentError,
  RANK,
  RetryError,
  setUpdateJobsPaused,
  SnoozeError,
  withOrigin,
  type Job,
  type QueueOptions,
} from './queue.ts'

const logger = pino({ level: 'silent' })
let queue: JobQueue | undefined

afterEach(async () => {
  await queue?.stop()
  queue = undefined
})

function setup(
  handlers: QueueOptions['handlers'],
  options: Partial<QueueOptions> = {},
) {
  const db = options.db ?? openDatabase(':memory:')
  queue = new JobQueue({
    db,
    logger,
    pollMs: 10,
    ...options,
    handlers,
    concurrency: options.concurrency ?? { main: 2 },
  })
  return { db, queue }
}

function addUpdate(db: Database, id: string) {
  db.insert(updates)
    .values({ id, target: 'many', collectionIds: [], options: {} as never })
    .run()
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

  test('claims free slots together and deletes finished rows with the next claim', async () => {
    const started: string[] = []
    const { db, queue } = setup(
      {
        echo: {
          queue: 'main',
          run: async (job) => {
            started.push(job.ref)
            // Let every slot fill before any job ends.
            await new Promise((resolve) => setTimeout(resolve, 5))
          },
        },
      },
      { concurrency: { main: 3 } },
    )
    for (const ref of ['a', 'b', 'c', 'd', 'e', 'f'])
      queue.enqueue(db, 'echo', ref)
    // Commits that change jobs: transactions, and statements outside one.
    let commits = 0
    const prepare = db.$client.prepare.bind(db.$client)
    db.$client.prepare = ((text: string) => {
      if (
        text === 'commit' ||
        (!db.$client.isTransaction &&
          /^(?:update|delete from) "jobs"/.test(text))
      )
        commits++
      return prepare(text)
    }) as typeof db.$client.prepare
    queue.start()
    await queue.drain()
    expect(started.toSorted()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(rows(db)).toEqual([])
    // One to claim and one to delete each job would be 12.
    expect(commits).toBeLessThan(8)
  })

  test('a finished job whose row cannot be deleted yet runs once', async () => {
    let runs = 0
    let now = 0
    const { db, queue } = setup(
      {
        echo: {
          queue: 'main',
          run: async () => {
            runs++
          },
        },
      },
      { now: () => now, timeoutMs: 1000 },
    )
    queue.enqueue(db, 'echo', 'a')
    // Deletes fail as if the database were locked; the row stays running.
    const run = db.$client.prepare.bind(db.$client)
    let locked = true
    db.$client.prepare = ((text: string) => {
      if (locked && /^delete from "jobs"/i.test(text))
        throw Object.assign(new Error('database is locked'), { errcode: 5 })
      return run(text)
    }) as typeof db.$client.prepare
    queue.start()
    await expect.poll(() => runs).toBe(1)
    // Long past its lease: a lost job would be offered again.
    now = 10 * 60_000
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runs).toBe(1)
    locked = false
    await expect.poll(() => rows(db)).toEqual([])
    expect(runs).toBe(1)
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
    // Its row goes with the next write (FINISH_DELAY).
    await expect.poll(() => rows(db)).toEqual([])
    db.$client.close()
  })

  test('a job enqueued by another process runs at the next look', async () => {
    const seen: string[] = []
    const handlers = {
      echo: {
        queue: 'main',
        run: async (job: Job) => {
          seen.push(job.ref)
        },
      },
    }
    const { db, queue } = setup(handlers)
    queue.start()
    // The web process's queue: it enqueues and never starts.
    const web = new JobQueue({
      db,
      logger,
      handlers,
      concurrency: { main: 2 },
    })
    web.enqueue(db, 'echo', 'from the web')
    await expect.poll(() => seen).toEqual(['from the web'])
  })

  test('nothing is claimed while all background work is paused', async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
        },
      },
    })
    writeJobControl(db, { paused: true, types: [] })
    queue.start()
    queue.enqueue(db, 'echo', 'a')
    await queue.drain()
    expect(seen).toEqual([])
    expect(rows(db)).toMatchObject([{ state: 'available', attempt: 0 }])

    writeJobControl(db, { paused: false, types: [] })
    await queue.drain()
    expect(seen).toEqual(['a'])
  })

  test('the pause outlasts a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'midden-queue-'))
    try {
      const file = path.join(dir, 'midden.db')
      const seen: string[] = []
      const handlers = {
        echo: {
          queue: 'main',
          run: async (job: Job) => {
            seen.push(job.ref)
          },
        },
      }
      const first = setup(handlers, { db: openDatabase(file) })
      writeJobControl(first.db, { paused: true, types: [] })
      first.queue.enqueue(first.db, 'echo', 'a')
      await first.queue.stop()
      first.db.$client.close()

      const second = setup(handlers, { db: openDatabase(file) })
      expect(readJobControl(second.db).paused).toBe(true)
      second.queue.start()
      await second.queue.drain()
      expect(seen).toEqual([])
      second.db.$client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a paused type waits while the others in its queue run', async () => {
    const seen: string[] = []
    const run = async (job: Job) => {
      seen.push(job.type)
    }
    const { db, queue } = setup(
      {
        download: { queue: 'download', run },
        thumbnail: { queue: 'download', priority: 4, run },
      },
      { concurrency: { download: 2 } },
    )
    writeJobControl(db, { paused: false, types: ['thumbnail'] })
    queue.enqueue(db, 'thumbnail', 't')
    queue.enqueue(db, 'download', 'd')
    queue.start()
    await queue.drain()
    expect(seen).toEqual(['download'])
    writeJobControl(db, { paused: false, types: [] })
    await queue.drain()
    expect(seen).toEqual(['download', 'thumbnail'])
  })

  test("a paused update's jobs wait, and what they enqueue does too", async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
          if (job.ref === 'parent') queue.enqueue(db, 'echo', 'child')
        },
      },
    })
    addUpdate(db, 'u1')
    addUpdate(db, 'u2')
    queue.enqueue(db, 'echo', 'parent', { updateId: 'u1' })
    queue.enqueue(db, 'echo', 'other', { updateId: 'u2' })
    db.update(updates)
      .set({ pausedAt: new Date() })
      .where(eq(updates.id, 'u1'))
      .run()
    setUpdateJobsPaused(db, 'u1', true)
    queue.start()
    await queue.drain()
    // The other update goes on.
    expect(seen).toEqual(['other'])
    expect(rows(db)).toMatchObject([{ ref: 'parent', state: 'paused' }])

    db.update(updates).set({ pausedAt: null }).where(eq(updates.id, 'u1')).run()
    setUpdateJobsPaused(db, 'u1', false)
    await queue.drain()
    expect(seen).toEqual(['other', 'parent', 'child'])
  })

  test('manual work runs before an update, and both before maintenance', async () => {
    const order: string[] = []
    const { db, queue } = setup(
      {
        echo: {
          queue: 'main',
          run: async (job) => {
            order.push(job.ref)
          },
        },
      },
      { concurrency: { main: 1 } },
    )
    addUpdate(db, 'u')
    withOrigin({ rank: RANK.maintenance }, () =>
      queue.enqueue(db, 'echo', 'maintenance'),
    )
    queue.enqueue(db, 'echo', 'update', { updateId: 'u' })
    queue.enqueue(db, 'echo', 'manual')
    queue.start()
    await queue.drain()
    expect(order).toEqual(['manual', 'update', 'maintenance'])
  })

  test('idle queues wait until the others have been quiet a while', async () => {
    let clock = 0
    const seen: string[] = []
    const run = async (job: Job) => {
      seen.push(job.ref)
    }
    const { db, queue } = setup(
      { work: { queue: 'main', run }, tidy: { queue: 'idle', run } },
      {
        concurrency: { main: 1, idle: 1 },
        idleQueues: ['idle'],
        idleAfterMs: 1000,
        now: () => clock,
      },
    )
    queue.enqueue(db, 'tidy', 'raw')
    queue.enqueue(db, 'work', 'capture')
    queue.start()
    await queue.drain()
    expect(seen).toEqual(['capture'])
    clock += 1000
    await queue.drain()
    expect(seen).toEqual(['capture', 'raw'])
  })

  test('the throttle lowers how many jobs run at once', async () => {
    let active = 0
    let peak = 0
    const { db, queue } = setup(
      {
        work: {
          queue: 'main',
          run: async () => {
            peak = Math.max(peak, ++active)
            await new Promise((resolve) => setTimeout(resolve, 5))
            active--
          },
        },
      },
      {
        concurrency: { main: 4 },
        throttle: { limit: (_queue, base) => base / 4, calm: () => true },
      },
    )
    for (let i = 0; i < 6; i++) queue.enqueue(db, 'work', String(i))
    queue.start()
    await queue.drain()
    expect(peak).toBe(1)
  })

  test('after a snooze the queue waits for its next look', async () => {
    let runs = 0
    const { db, queue } = setup(
      {
        busy: {
          queue: 'main',
          run: async () => {
            runs++
            throw new SnoozeError(0)
          },
        },
      },
      { concurrency: { main: 1 }, pollMs: 60_000 },
    )
    for (let i = 0; i < 50; i++) queue.enqueue(db, 'busy', String(i))
    queue.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // One claim, not fifty snoozes in a row.
    expect(runs).toBe(1)
  })

  test('held, it claims nothing until released', async () => {
    const seen: string[] = []
    const { db, queue } = setup({
      echo: {
        queue: 'main',
        run: async (job) => {
          seen.push(job.ref)
        },
      },
    })
    queue.hold('newer schema')
    queue.enqueue(db, 'echo', 'a')
    queue.start()
    await queue.drain()
    expect(seen).toEqual([])
    expect(queue.status().held).toBe('newer schema')
    queue.hold(null)
    await queue.drain()
    expect(seen).toEqual(['a'])
  })
})
