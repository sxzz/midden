import { AsyncLocalStorage } from 'node:async_hooks'
import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { jobs, updates } from '#db/schema.ts'
import { readJobControl, type JobControl } from './control.ts'
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

/**
 * The API the job asks is rate-limited (`rate-limits.ts`): wait for the
 * limit's end without using an attempt.
 */
export class RateLimitError extends Error {
  override name = 'RateLimitError'
  readonly scope: string
  /** Epoch ms. */
  readonly until: number
  constructor(scope: string, until: number, options?: ErrorOptions) {
    super(
      `rate-limited (${scope}) until ${new Date(until).toISOString()}`,
      options,
    )
    this.scope = scope
    this.until = until
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

/**
 * Where work comes from, added to the handler's priority: what the owner
 * asked for runs first, then an update started by hand, then a watch's
 * (定期更新), then maintenance.
 */
export const RANK = { manual: 0, update: 1, watch: 2, maintenance: 3 } as const
export type Rank = (typeof RANK)[keyof typeof RANK]
const RANKS: Rank[] = Object.values(RANK)

/** What jobs enqueued here belong to; jobs inherit it from the job running. */
export interface JobOrigin {
  /** The update (更新) the work is part of. */
  updateId?: string | null
  rank?: Rank
}

interface Scope {
  updateId: string | null
  rank: Rank
  /** The job running, for logs. */
  job?: { id: number; type: string; ref: string }
}

const scope = new AsyncLocalStorage<Scope>()

/**
 * Run `fn` with jobs it enqueues belonging to `origin`, e.g. the worker's
 * maintenance (lowest rank) or an action on an update from the web.
 */
export function withOrigin<T>(origin: JobOrigin, fn: () => T): T {
  const current = scope.getStore()
  return scope.run(
    {
      updateId:
        origin.updateId === undefined
          ? (current?.updateId ?? null)
          : origin.updateId,
      rank: origin.rank ?? current?.rank ?? RANK.manual,
    },
    fn,
  )
}

/** The job this code runs for, if any. */
export function currentJob(): Scope['job'] {
  return scope.getStore()?.job
}

/**
 * Lowers how many jobs run while the web process is slow or the write lock
 * is contended (`throttle.ts`).
 */
export interface QueueThrottle {
  /** How many jobs of `queue` may run now, out of its configured `base`. */
  limit: (queue: string, base: number) => number
  /** Whether work that waits for an idle worker may run. */
  calm: () => boolean
}

export interface QueueOptions {
  db: Database
  logger: Logger
  handlers: Record<string, JobHandler>
  /** Concurrent jobs per queue. */
  concurrency: Record<string, number>
  /**
   * Queues that run only while the others have had nothing to run for a
   * while (`idleAfterMs`) and the throttle is calm, such as moving raw
   * responses out of the database.
   */
  idleQueues?: string[]
  idleAfterMs?: number
  throttle?: QueueThrottle
  timeoutMs?: number
  /**
   * How often to look for due jobs. Jobs enqueued in this process start at
   * once; ones another process (the web) enqueues wait for the next look.
   */
  pollMs?: number
  now?: () => number
  /** Failures retrying cannot fix, besides `PermanentError`. */
  isPermanent?: (error: unknown) => boolean
}

/** What the worker is doing, for the admin page and its status file. */
export interface QueueStatus {
  running: Record<string, number>
  limits: Record<string, number>
  /** Idle queues may run. */
  idle: boolean
  control: JobControl
  /** Why claiming stopped, other than a pause (e.g. a newer schema). */
  held: string | null
}

const DEFAULT_TIMEOUT = 10 * 60_000
const DEFAULT_ATTEMPTS = 3
// A job running past its timeout plus this grace is assumed lost.
const LEASE_GRACE = 60_000
const RESCUE_EVERY = 5000
// A finished job's row is deleted with the next claim, or this much later
// on its own: one write for many jobs, rather than one each.
const FINISH_DELAY = 50
const IDLE_AFTER = 10_000
/** Types whose priorities no other type in their queue shares. */
export const PAUSABLE_TYPES = ['upload', 'raw-upload'] as const

/** Exponential backoff from 2 s, capped at about four minutes. */
export function backoff(attempt: number): number {
  return 2 ** Math.min(Math.max(attempt, 1), 8) * 1000
}

type Row = typeof jobs.$inferSelect

export class JobQueue {
  readonly #db: Database
  readonly #logger: Logger
  readonly #handlers: Record<string, JobHandler>
  readonly #concurrency: Record<string, number>
  readonly #idleQueues: Set<string>
  readonly #idleAfterMs: number
  readonly #throttle: QueueThrottle | undefined
  readonly #timeoutMs: number
  readonly #pollMs: number
  readonly #now: () => number
  readonly #isPermanent: (error: unknown) => boolean
  readonly #running = new Map<string, Set<Promise<void>>>()
  /** The priorities each type's jobs can have, for claiming by index. */
  readonly #priorities = new Map<string, number[]>()
  readonly #stop = new AbortController()
  #timer: NodeJS.Timeout | undefined
  #started = false
  #reset = false
  #rescuedAt = -Infinity
  #foregroundAt = -Infinity
  #control: JobControl = { paused: false, types: [] }
  /** Queues whose last job snoozed: not pumped until the next look. */
  readonly #snoozing = new Set<string>()
  #held: string | null = null
  /** Jobs that finished, their rows not yet deleted. */
  readonly #finished = new Set<number>()
  #finishTimer: NodeJS.Timeout | undefined

  constructor(options: QueueOptions) {
    this.#db = options.db
    this.#logger = options.logger
    this.#handlers = options.handlers
    this.#concurrency = options.concurrency
    this.#idleQueues = new Set(options.idleQueues)
    this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER
    this.#throttle = options.throttle
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    this.#pollMs = options.pollMs ?? 1000
    this.#now = options.now ?? Date.now
    this.#isPermanent = options.isPermanent ?? (() => false)
    for (const [type, handler] of Object.entries(this.#handlers)) {
      if (!this.#concurrency[handler.queue])
        throw new Error(`No concurrency configured for queue ${handler.queue}`)
      const base = handler.priority ?? 0
      this.#priorities.set(
        type,
        RANKS.map((rank) => base + rank),
      )
    }
    // Pausing a type leaves out its priorities when claiming, so no other
    // type in its queue may share them.
    for (const type of PAUSABLE_TYPES) {
      const own = this.#priorities.get(type)
      if (!own) continue
      const queue = this.#handlers[type]!.queue
      for (const [other, handler] of Object.entries(this.#handlers))
        if (
          other !== type &&
          handler.queue === queue &&
          this.#priorities.get(other)!.some((p) => own.includes(p))
        )
          throw new Error(`${type} shares priorities with ${other}`)
    }
  }

  /**
   * Add a job. Pass the open transaction when the job belongs to a write, so
   * the job exists exactly when the write commits. It belongs to the update
   * the running job (or `withOrigin`) belongs to, unless `updateId` says.
   * Returns the job's id.
   */
  enqueue(
    executor: Executor,
    type: string,
    ref: string,
    options: { delayMs?: number } & JobOrigin = {},
  ): number {
    const handler = this.#handlers[type]
    if (!handler) throw new Error(`Unknown job type ${type}`)
    const current = scope.getStore()
    const updateId =
      options.updateId === undefined
        ? (current?.updateId ?? null)
        : options.updateId
    // An update's work ranks at least as its update does, whoever enqueues
    // it (a retry from the web, say).
    const update = updateId ? updateOf(executor, updateId) : undefined
    const rank = Math.max(
      options.rank ?? current?.rank ?? RANK.manual,
      update?.rank ?? RANK.manual,
    )
    const now = this.#now()
    const { id } = executor
      .insert(jobs)
      .values({
        type,
        ref,
        queue: handler.queue,
        priority: (handler.priority ?? 0) + rank,
        state: update?.paused ? 'paused' : 'available',
        maxAttempts: handler.maxAttempts ?? DEFAULT_ATTEMPTS,
        runAt: new Date(now + (options.delayMs ?? 0)),
        createdAt: new Date(now),
        updateId,
      })
      .returning({ id: jobs.id })
      .get()!
    // After the caller's transaction commits; a rolled-back job is not found.
    if (this.#started) queueMicrotask(() => this.#pump(handler.queue))
    return id
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#tick()
  }

  // Every database call here can find the write lock held for longer than
  // the busy timeout (a checkpoint, a long write): log it and try again on
  // the next tick, never let it escape a timer and end the process.
  #retryLater(error: unknown, what: string, fields: object = {}): void {
    this.#logger.warn(
      { err: error, ...fields },
      `${what} failed; trying again on the next tick`,
    )
  }

  /** Stop claiming work and wait for running jobs to settle. */
  async stop(): Promise<void> {
    this.#started = false
    clearTimeout(this.#timer)
    this.#stop.abort()
    await Promise.allSettled(
      [...this.#running.values()].flatMap((set) => [...set]),
    )
    clearTimeout(this.#finishTimer)
    this.#deleteFinished()
  }

  /** Wait until no job is running or due now. Meant for tests. */
  async drain(): Promise<void> {
    for (;;) {
      this.#refreshControl()
      this.#snoozing.clear()
      for (const queue of Object.keys(this.#concurrency)) this.#pump(queue)
      const running = [...this.#running.values()].flatMap((set) => [...set])
      if (running.length === 0) {
        this.#deleteFinished()
        return
      }
      await Promise.allSettled(running)
    }
  }

  /**
   * Stop claiming (`reason`) or claim again (null), e.g. while a newer
   * version's migrations are in the database. Running jobs go on.
   */
  hold(reason: string | null): void {
    this.#held = reason
    if (!reason)
      for (const queue of Object.keys(this.#concurrency)) this.#pump(queue)
  }

  status(): QueueStatus {
    const running: Record<string, number> = {}
    const limits: Record<string, number> = {}
    for (const queue of Object.keys(this.#concurrency)) {
      running[queue] = this.#running.get(queue)?.size ?? 0
      limits[queue] = this.#limit(queue)
    }
    return {
      running,
      limits,
      idle: this.#idle(),
      control: this.#control,
      held: this.#held,
    }
  }

  #tick(): void {
    if (!this.#started) return
    try {
      this.#refreshControl()
      if (!this.#reset) {
        // Only one process runs jobs: anything still marked running was cut
        // off by a restart.
        this.#db
          .update(jobs)
          .set({ state: this.#waitingState(), leaseUntil: null })
          .where(eq(jobs.state, 'running'))
          .run()
        this.#reset = true
      }
      if (this.#now() - this.#rescuedAt >= RESCUE_EVERY) this.#rescue()
    } catch (error) {
      this.#retryLater(error, 'releasing lost jobs')
    }
    this.#snoozing.clear()
    for (const queue of Object.keys(this.#concurrency)) this.#pump(queue)
    this.#timer = setTimeout(() => this.#tick(), this.#pollMs)
    this.#timer.unref()
  }

  #refreshControl(): void {
    this.#control = readJobControl(this.#db)
  }

  // A handler that ignores its abort signal keeps its slot; once its lease
  // runs out the job is offered again rather than lost. Looked for with a
  // read first: an UPDATE takes the write lock even when nothing matches.
  // Every queue named, so the claim index finds the running jobs.
  #rescue(): void {
    this.#rescuedAt = this.#now()
    const expired = and(
      inArray(jobs.queue, Object.keys(this.#concurrency)),
      eq(jobs.state, 'running'),
      lt(jobs.leaseUntil, new Date(this.#now())),
    )
    const lost = this.#db
      .select({ id: jobs.id, updateId: jobs.updateId })
      .from(jobs)
      .where(expired)
      .all()
      // Finished, its row still to be deleted (the database was locked).
      .filter((row) => !this.#finished.has(row.id))
    for (const row of lost)
      this.#db
        .update(jobs)
        .set({ state: this.#waitingState(row.updateId), leaseUntil: null })
        .where(and(eq(jobs.id, row.id), expired))
        .run()
  }

  /** `available`, or `paused` while the job's update is paused. */
  #waitingState(updateId?: string | null) {
    if (updateId === undefined)
      // Every job: a CASE per row.
      return sql<
        'available' | 'paused'
      >`CASE WHEN ${jobs.updateId} IN (SELECT ${updates.id} FROM ${updates} WHERE ${isNotNull(updates.pausedAt)}) THEN 'paused' ELSE 'available' END`
    return updateId && updatePaused(this.#db, updateId) ? 'paused' : 'available'
  }

  /** How many jobs of the queue may run now. */
  #limit(queue: string): number {
    const base = this.#concurrency[queue] ?? 0
    if (this.#idleQueues.has(queue) && !this.#idle()) return 0
    return this.#throttle ? this.#throttle.limit(queue, base) : base
  }

  #idle(): boolean {
    for (const [queue, running] of this.#running)
      if (!this.#idleQueues.has(queue) && running.size)
        this.#foregroundAt = this.#now()
    return (
      this.#now() - this.#foregroundAt >= this.#idleAfterMs &&
      (this.#throttle?.calm() ?? true)
    )
  }

  /** Priorities of the queue's types that are not paused. */
  #claimable(queue: string): number[] {
    const priorities: number[] = []
    for (const [type, handler] of Object.entries(this.#handlers))
      if (handler.queue === queue && !this.#control.types.includes(type))
        priorities.push(...this.#priorities.get(type)!)
    return [...new Set(priorities)]
  }

  #pump(queue: string): void {
    if (this.#stop.signal.aborted || this.#control.paused || this.#held) return
    if (this.#snoozing.has(queue)) return
    let running = this.#running.get(queue)
    if (!running) this.#running.set(queue, (running = new Set()))
    if (running.size >= this.#limit(queue)) return
    const priorities = this.#claimable(queue)
    if (!priorities.length) return
    const free = this.#limit(queue) - running.size
    let rows
    try {
      rows = this.#claim(queue, priorities, free)
    } catch (error) {
      this.#retryLater(error, 'claiming a job', { queue })
      return
    }
    if (rows.length && !this.#idleQueues.has(queue))
      this.#foregroundAt = this.#now()
    for (const row of rows) {
      const settled = (outcome: 'done' | 'snoozed' | 'failed') => {
        running.delete(task)
        // A job that snoozed (its account busy, say) is likely followed by
        // others waiting on the same: claiming them one after another
        // would only snooze each again. Wait for the next look, or for a
        // job of the queue to end.
        if (outcome === 'snoozed') this.#snoozing.add(queue)
        else this.#snoozing.delete(queue)
        // A turn of the event loop first: claiming straight from here
        // chains microtasks, and a queue of quick jobs would keep requests
        // and timers waiting until it ran dry.
        setImmediate(() => this.#pump(queue))
      }
      const task: Promise<void> = this.#execute(row).then(settled, () =>
        settled('failed'),
      )
      running.add(task)
    }
  }

  // Looked for with a read, then taken by id: most looks find nothing, and
  // a read does not take the write lock. Only this process claims, so the
  // jobs cannot be taken in between; the state check guards it anyway.
  // The same transaction deletes the rows of jobs that finished.
  #claim(queue: string, priorities: number[], limit: number): Row[] {
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
          inArray(jobs.priority, priorities),
          lte(jobs.runAt, new Date(now)),
        ),
      )
      .orderBy(asc(jobs.priority), asc(jobs.runAt), asc(jobs.id))
      .limit(limit)
      .all()
    if (!next.length) return []
    const finished = [...this.#finished]
    const rows = this.#db.transaction((tx) => {
      if (finished.length)
        tx.delete(jobs).where(inArray(jobs.id, finished)).run()
      return tx
        .update(jobs)
        .set({
          state: 'running',
          attempt: sql`${jobs.attempt} + 1`,
          leaseUntil: new Date(now + this.#timeoutMs + LEASE_GRACE),
        })
        .where(
          and(
            inArray(
              jobs.id,
              next.map((row) => row.id),
            ),
            eq(jobs.state, 'available'),
          ),
        )
        .returning()
        .all()
    })
    for (const id of finished) this.#finished.delete(id)
    // In the order they were looked for; RETURNING follows no order.
    const order = new Map(next.map((row, i) => [row.id, i]))
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!)
  }

  /** Delete a finished job's row soon, with others (`FINISH_DELAY`). */
  #finish(id: number): void {
    this.#finished.add(id)
    if (this.#finishTimer) return
    this.#finishTimer = setTimeout(() => {
      this.#finishTimer = undefined
      this.#deleteFinished()
    }, FINISH_DELAY)
    this.#finishTimer.unref()
  }

  #deleteFinished(): void {
    if (!this.#finished.size) return
    const finished = [...this.#finished]
    try {
      this.#db.delete(jobs).where(inArray(jobs.id, finished)).run()
      for (const id of finished) this.#finished.delete(id)
    } catch (error) {
      // The rows stay running and the ids here, so #rescue leaves them be.
      this.#retryLater(error, 'deleting finished jobs')
      if (this.#started) this.#finish(finished[0]!)
    }
  }

  #execute(row: Row): Promise<'done' | 'snoozed' | 'failed'> {
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
    const base = this.#handlers[row.type]?.priority ?? 0
    const context: Scope = {
      updateId: row.updateId,
      rank: Math.min(
        Math.max(row.priority - base, 0),
        RANK.maintenance,
      ) as Rank,
      job: { id: row.id, type: row.type, ref: row.ref },
    }
    return scope.run(context, async () => {
      let error: unknown
      try {
        if (!handler) throw new PermanentError(`Unknown job type ${row.type}`)
        await handler.run(job)
      } catch (error_) {
        error = error_ ?? new Error('job failed')
      }
      try {
        if (error === undefined) {
          this.#finish(row.id)
          log.debug({ elapsedMs: this.#now() - started }, 'job finished')
          return 'done'
        }
        return await this.#failed(
          row,
          job,
          handler,
          error,
          log,
          this.#now() - started,
        )
      } catch (bookkeeping) {
        // The row stays running: once its lease ends, #rescue offers it
        // again.
        log.error({ err: bookkeeping }, 'recording a job outcome failed')
        return 'failed'
      }
    })
  }

  async #failed(
    row: Row,
    job: Job,
    handler: JobHandler | undefined,
    error: unknown,
    log: Logger,
    elapsedMs: number,
  ): Promise<'snoozed' | 'failed'> {
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
          state: this.#waitingState(row.updateId),
          leaseUntil: null,
          attempt: row.attempt - 1,
          runAt: new Date(this.#now() + snooze),
          rateScope: null,
        })
        .where(eq(jobs.id, row.id))
        .run()
      return 'snoozed'
    }
    // Not the job's fault either. Its due time is the limit's end, so it is
    // not looked at again until then. Not a snooze: the next job of the
    // queue may well ask another API, and one asking this API gives up at
    // once without a request.
    if (error instanceof RateLimitError) {
      log.info(
        { scope: error.scope, until: new Date(error.until).toISOString() },
        'job waits for a rate limit',
      )
      this.#db
        .update(jobs)
        .set({
          state: this.#waitingState(row.updateId),
          leaseUntil: null,
          attempt: row.attempt - 1,
          runAt: new Date(Math.max(error.until, this.#now())),
          rateScope: error.scope,
        })
        .where(eq(jobs.id, row.id))
        .run()
      return 'failed'
    }
    const message = error instanceof Error ? error.message : String(error)
    const final =
      error instanceof PermanentError ||
      this.#isPermanent(error) ||
      row.attempt >= row.maxAttempts
    // Each attempt is logged: the job row and its last error go away once
    // the job ends, and a later retry overwrites what the record shows.
    const fields = {
      err: error,
      maxAttempts: row.maxAttempts,
      elapsedMs,
      sinceQueuedMs: this.#now() - row.createdAt.getTime(),
    }
    if (final) {
      log.error({ ...fields, state: 'failed' }, 'job failed')
      try {
        await handler?.fail?.(job, error)
      } catch (failError) {
        log.error({ err: failError }, 'recording job failure failed')
      }
      this.#db.delete(jobs).where(eq(jobs.id, row.id)).run()
      return 'failed'
    }
    const delay =
      error instanceof RetryError ? error.afterMs : backoff(row.attempt)
    log.warn({ ...fields, retryInMs: delay }, 'job will retry')
    this.#db
      .update(jobs)
      .set({
        state: this.#waitingState(row.updateId),
        leaseUntil: null,
        lastError: message,
        runAt: new Date(this.#now() + delay),
        rateScope: null,
      })
      .where(eq(jobs.id, row.id))
      .run()
    return 'failed'
  }
}

function updatePaused(executor: Executor, updateId: string): boolean {
  return !!updateOf(executor, updateId)?.paused
}

/** Whether an update is paused, and the rank of its work. */
function updateOf(
  executor: Executor,
  updateId: string,
): { paused: boolean; rank: Rank } {
  const row = executor
    .select({ pausedAt: updates.pausedAt, origin: updates.origin })
    .from(updates)
    .where(eq(updates.id, updateId))
    .get()
  return {
    paused: !!row?.pausedAt,
    rank: row?.origin === 'watch' ? RANK.watch : RANK.update,
  }
}

/**
 * Pause or resume an update's waiting jobs. Running ones finish; the queue
 * keeps what they enqueue paused while the update is (`enqueue`).
 */
export function setUpdateJobsPaused(
  executor: Executor,
  updateId: string,
  paused: boolean,
): number {
  const { changes } = executor
    .update(jobs)
    .set({ state: paused ? 'paused' : 'available' })
    .where(
      and(
        eq(jobs.updateId, updateId),
        eq(jobs.state, paused ? 'available' : 'paused'),
      ),
    )
    .run()
  return Number(changes)
}
