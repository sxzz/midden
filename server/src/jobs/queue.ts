import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm'
import { jobs } from '#db/schema.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Logger } from '#log.ts'

/** A failure that retrying cannot fix; the job fails at once. */
export class PermanentError extends Error {
  override name = 'PermanentError'
}

/** A temporary failure that names when to try again (e.g. a rate limit). */
export class RetryError extends Error {
  override name = 'RetryError'
  readonly afterMs: number
  constructor(message: string, afterMs: number, options?: ErrorOptions) {
    super(message, options)
    this.afterMs = afterMs
  }
}

/** Try again later without using an attempt (e.g. a busy account). */
export class SnoozeError extends Error {
  override name = 'SnoozeError'
  readonly afterMs: number
  constructor(afterMs: number) {
    super(`snoozed for ${afterMs} ms`)
    this.afterMs = afterMs
  }
}

export interface Job {
  id: number
  type: string
  ref: string
  attempt: number
  maxAttempts: number
  signal: AbortSignal
}

export interface JobHandler {
  queue: string
  /** Lower runs first within the queue. */
  priority?: number
  maxAttempts?: number
  run: (job: Job) => Promise<void>
  /** Record a final failure: permanent, or out of attempts. */
  fail?: (job: Job, error: unknown) => Promise<void> | void
}

export interface QueueOptions {
  db: Database
  logger: Logger
  handlers: Record<string, JobHandler>
  /** Concurrent jobs per queue. */
  concurrency: Record<string, number>
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  /** Failures retrying cannot fix, besides `PermanentError`. */
  isPermanent?: (error: unknown) => boolean
}

const DEFAULT_TIMEOUT = 10 * 60_000
const DEFAULT_ATTEMPTS = 3
// A job running past its timeout plus this grace is assumed lost.
const LEASE_GRACE = 60_000

/** Exponential backoff from 2 s, capped at about four minutes. */
export function backoff(attempt: number): number {
  return 2 ** Math.min(Math.max(attempt, 1), 8) * 1000
}

export class JobQueue {
  readonly #db: Database
  readonly #logger: Logger
  readonly #handlers: Record<string, JobHandler>
  readonly #concurrency: Record<string, number>
  readonly #timeoutMs: number
  readonly #pollMs: number
  readonly #now: () => number
  readonly #isPermanent: (error: unknown) => boolean
  readonly #running = new Map<string, Set<Promise<void>>>()
  /** The priorities each queue's jobs can have, for claiming by index. */
  readonly #priorities = new Map<string, number[]>()
  readonly #stop = new AbortController()
  #timer: NodeJS.Timeout | undefined
  #started = false

  constructor(options: QueueOptions) {
    this.#db = options.db
    this.#logger = options.logger
    this.#handlers = options.handlers
    this.#concurrency = options.concurrency
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    this.#pollMs = options.pollMs ?? 1000
    this.#now = options.now ?? Date.now
    this.#isPermanent = options.isPermanent ?? (() => false)
    for (const handler of Object.values(this.#handlers)) {
      if (!this.#concurrency[handler.queue])
        throw new Error(`No concurrency configured for queue ${handler.queue}`)
      const priorities = this.#priorities.get(handler.queue) ?? []
      const priority = handler.priority ?? 0
      if (!priorities.includes(priority)) priorities.push(priority)
      this.#priorities.set(handler.queue, priorities)
    }
  }

  /**
   * Add a job. Pass the open transaction when the job belongs to a write, so
   * the job exists exactly when the write commits.
   */
  enqueue(
    executor: Executor,
    type: string,
    ref: string,
    options: { delayMs?: number } = {},
  ): void {
    const handler = this.#handlers[type]
    if (!handler) throw new Error(`Unknown job type ${type}`)
    const now = this.#now()
    executor
      .insert(jobs)
      .values({
        type,
        ref,
        queue: handler.queue,
        priority: handler.priority ?? 0,
        maxAttempts: handler.maxAttempts ?? DEFAULT_ATTEMPTS,
        runAt: new Date(now + (options.delayMs ?? 0)),
        createdAt: new Date(now),
      })
      .run()
    // After the caller's transaction commits; a rolled-back job is not found.
    if (this.#started) queueMicrotask(() => this.#pump(handler.queue))
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    // Single process: anything still marked running was cut off by a restart.
    this.#db
      .update(jobs)
      .set({ state: 'available', leaseUntil: null })
      .where(eq(jobs.state, 'running'))
      .run()
    this.#tick()
  }

  /** Stop claiming work and wait for running jobs to settle. */
  async stop(): Promise<void> {
    this.#started = false
    clearTimeout(this.#timer)
    this.#stop.abort()
    await Promise.allSettled(
      [...this.#running.values()].flatMap((set) => [...set]),
    )
  }

  /** Wait until no job is running or due now. Meant for tests. */
  async drain(): Promise<void> {
    for (;;) {
      for (const queue of Object.keys(this.#concurrency)) this.#pump(queue)
      const running = [...this.#running.values()].flatMap((set) => [...set])
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  #tick(): void {
    if (!this.#started) return
    this.#rescue()
    for (const queue of Object.keys(this.#concurrency)) this.#pump(queue)
    this.#timer = setTimeout(() => this.#tick(), this.#pollMs)
    this.#timer.unref()
  }

  // A handler that ignores its abort signal keeps its slot; once its lease
  // runs out the job is offered again rather than lost.
  #rescue(): void {
    this.#db
      .update(jobs)
      .set({ state: 'available', leaseUntil: null })
      .where(
        and(
          eq(jobs.state, 'running'),
          lt(jobs.leaseUntil, new Date(this.#now())),
        ),
      )
      .run()
  }

  #pump(queue: string): void {
    if (this.#stop.signal.aborted) return
    const limit = this.#concurrency[queue] ?? 0
    let running = this.#running.get(queue)
    if (!running) this.#running.set(queue, (running = new Set()))
    while (running.size < limit) {
      const row = this.#claim(queue)
      if (!row) return
      const task = this.#execute(row).finally(() => {
        running.delete(task)
        this.#pump(queue)
      })
      running.add(task)
    }
  }

  #claim(queue: string) {
    const now = this.#now()
    const next = this.#db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, queue),
          eq(jobs.state, 'available'),
          // Naming the priorities lets the index skip to due jobs at each one
          // instead of walking every delayed job.
          inArray(jobs.priority, this.#priorities.get(queue) ?? [0]),
          lte(jobs.runAt, new Date(now)),
        ),
      )
      .orderBy(asc(jobs.priority), asc(jobs.runAt), asc(jobs.id))
      .limit(1)
    return this.#db
      .update(jobs)
      .set({
        state: 'running',
        attempt: sql`${jobs.attempt} + 1`,
        leaseUntil: new Date(now + this.#timeoutMs + LEASE_GRACE),
      })
      .where(and(inArray(jobs.id, next), eq(jobs.state, 'available')))
      .returning()
      .get()
  }

  async #execute(row: typeof jobs.$inferSelect): Promise<void> {
    const handler = this.#handlers[row.type]
    const signal = AbortSignal.any([
      this.#stop.signal,
      AbortSignal.timeout(this.#timeoutMs),
    ])
    const job: Job = {
      id: row.id,
      type: row.type,
      ref: row.ref,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      signal,
    }
    const log = this.#logger.child({
      jobId: row.id,
      jobType: row.type,
      ref: row.ref,
      attempt: row.attempt,
    })
    const started = this.#now()
    try {
      if (!handler) throw new PermanentError(`Unknown job type ${row.type}`)
      await handler.run(job)
      this.#db.delete(jobs).where(eq(jobs.id, row.id)).run()
      log.debug({ elapsedMs: this.#now() - started }, 'job finished')
    } catch (error) {
      await this.#failed(row, job, handler, error, log)
    }
  }

  async #failed(
    row: typeof jobs.$inferSelect,
    job: Job,
    handler: JobHandler | undefined,
    error: unknown,
    log: Logger,
  ): Promise<void> {
    // Shutting down is not the job's fault: run it again on the next start.
    const snooze =
      error instanceof SnoozeError
        ? error.afterMs
        : this.#stop.signal.aborted
          ? 0
          : undefined
    if (snooze !== undefined) {
      this.#db
        .update(jobs)
        .set({
          state: 'available',
          leaseUntil: null,
          attempt: row.attempt - 1,
          runAt: new Date(this.#now() + snooze),
        })
        .where(eq(jobs.id, row.id))
        .run()
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const final =
      error instanceof PermanentError ||
      this.#isPermanent(error) ||
      row.attempt >= row.maxAttempts
    if (final) {
      log.warn({ err: error }, 'job failed')
      try {
        await handler?.fail?.(job, error)
      } catch (failError) {
        log.error({ err: failError }, 'recording job failure failed')
      }
      this.#db.delete(jobs).where(eq(jobs.id, row.id)).run()
      return
    }
    const delay =
      error instanceof RetryError ? error.afterMs : backoff(row.attempt)
    log.info({ err: error, retryInMs: delay }, 'job will retry')
    this.#db
      .update(jobs)
      .set({
        state: 'available',
        leaseUntil: null,
        lastError: message,
        runAt: new Date(this.#now() + delay),
      })
      .where(eq(jobs.id, row.id))
      .run()
  }
}
