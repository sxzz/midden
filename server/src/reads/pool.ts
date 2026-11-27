import { Worker, type Transferable } from 'node:worker_threads'
import type { Logger } from '#log.ts'
import type { SlowQuery } from './slow.ts'

/** The read threads' module (`thread.ts`). */
export const READ_THREAD = new URL('thread.ts', import.meta.url)

/**
 * Who a read is for. `web`: the web app's own `GET /v1` requests; `agent`:
 * the agent API's reads. Each has its own deadlines, and the agent's may
 * hold only some of the threads, so the web app always has some left.
 */
export type Lane = 'web' | 'agent'

export interface LaneLimits {
  /** How long a read may run. */
  timeoutMs: number
  /** How long a read may wait for a thread (one starting, say). */
  waitMs: number
  /** Threads this lane may hold at once; all of them when absent. */
  max?: number
}

/**
 * Four threads: the agent API's two requests at a time (its gate) each
 * hold one, so at least two are always free for the web app, which polls
 * a few lists at once while an update runs. More would only compete for
 * the CPU with the worker process; each thread also keeps a connection and
 * its page cache.
 */
export const POOL_SIZE = 4
export const LANES: Record<Lane, LaneLimits> = {
  // The web app's heaviest reads (the relation graph of a large account)
  // take seconds; past this one has gone wrong.
  web: { timeoutMs: 30_000, waitMs: 30_000 },
  // The agent API promises its callers this (`query_timeout`).
  agent: { timeoutMs: 5000, waitMs: 5000, max: 2 },
}

/**
 * Threads that timed out and may still be inside SQLite: they stop only when
 * it returns to JavaScript. Beyond this many no new thread replaces them,
 * so a run of slow queries cannot pile up threads; requests wait instead.
 */
const MAX_RETIRING = 2

/** What the main thread sends a read thread; `id` 0 wants no answer. */
export interface PoolRequest {
  id: number
  op: string
  input: unknown
}

/**
 * What a read thread sends: first that it is ready, then the answer to each
 * request, and log lines (`log`, pino's JSON) and slow queries (`slow`)
 * meanwhile.
 */
export type PoolResponse =
  | { ready: true }
  | { log: string }
  | { slow: SlowQuery }
  | { id: number; ok: true; value: unknown }
  /** `error`: what the caller answers; `cause`: an unexpected error's stack. */
  | { id: number; ok: false; error: unknown; cause?: string }

/** Why the pool could not run a read. */
export type PoolErrorCode = 'busy' | 'timeout' | 'lost'

export class PoolError extends Error {
  override name = 'PoolError'
  readonly code: PoolErrorCode
  readonly timeoutMs: number
  constructor(code: PoolErrorCode, message: string, timeoutMs = 0) {
    super(message)
    this.code = code
    this.timeoutMs = timeoutMs
  }
}

/** A read that failed on its thread, with what the thread answered. */
export class ThreadError extends Error {
  override name = 'ThreadError'
  readonly body: unknown
  constructor(body: unknown) {
    super('read failed')
    this.body = body
  }
}

interface Task {
  id: number
  lane: Lane
  op: string
  input: unknown
  transfer?: Transferable[]
  onStart?: () => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  thread?: Thread
}

interface Thread {
  worker: Worker
  /** It opened its connection and listens. */
  ready: boolean
  task?: Task
}

export interface PoolOptions {
  /** The thread's module; it answers `PoolRequest`s (`thread.ts`). */
  script: URL
  workerData: unknown
  size?: number
  lanes?: Partial<Record<Lane, Partial<LaneLimits>>>
  logger?: Logger
  /** A thread's statement was slow (`slow.ts`). */
  onSlow?: (query: SlowQuery) => void
}

/**
 * Worker threads for reads. node:sqlite is synchronous, so a query on the
 * web process's own thread holds up every request; here each thread has its
 * own read-only connection. One read per thread at a time; the web app's
 * reads go first, and the agent API's hold at most their lane's `max`.
 * Threads start with the first reads (or `warm`).
 */
export class QueryPool {
  readonly size: number
  readonly lanes: Record<Lane, LaneLimits>
  readonly #options: PoolOptions
  #threads: Thread[] = []
  #queues: Record<Lane, Task[]> = { web: [], agent: [] }
  #retiring = 0
  #next = 1
  #closed = false

  constructor(options: PoolOptions) {
    this.#options = options
    this.size = options.size ?? POOL_SIZE
    this.lanes = {
      web: { ...LANES.web, ...options.lanes?.web },
      agent: { ...LANES.agent, ...options.lanes?.agent },
    }
  }

  /** Threads running now, and those that timed out and are still ending. */
  get threads(): { live: number; retiring: number } {
    return { live: this.#threads.length, retiring: this.#retiring }
  }

  /** Start up to `count` threads now, so the first reads need not wait. */
  warm(count = this.size): void {
    while (!this.#closed && this.#threads.length < Math.min(count, this.size))
      this.#spawn()
  }

  /**
   * Run `op` on a thread. `onStart` is called when a thread takes it, so the
   * caller can tell the wait for a thread from the read itself.
   */
  run(
    lane: Lane,
    op: string,
    input: unknown,
    transfer?: Transferable[],
    onStart?: () => void,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new PoolError('busy', 'The server is stopping.'))
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: this.#next++,
        lane,
        op,
        input,
        transfer,
        onStart,
        resolve,
        reject,
        timer: setTimeout(() => this.#unserved(task), this.lanes[lane].waitMs),
      }
      this.#queues[lane].push(task)
      this.#dispatch()
    })
  }

  /**
   * Tell every thread something that needs no answer, before any read it
   * takes next (`forget`: what was kept between reads is out of date).
   */
  broadcast(op: string): void {
    for (const thread of this.#threads)
      thread.worker.postMessage({
        id: 0,
        op,
        input: null,
      } satisfies PoolRequest)
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const task of [
      ...this.#queues.web.splice(0),
      ...this.#queues.agent.splice(0),
    ]) {
      clearTimeout(task.timer)
      task.reject(new PoolError('busy', 'The server is stopping.'))
    }
    await Promise.all(
      this.#threads.splice(0).map((thread) => thread.worker.terminate()),
    )
  }

  /** The lane whose read runs next: the web app's first, within limits. */
  #nextLane(): Lane | undefined {
    if (this.#queues.web.length) return 'web'
    if (!this.#queues.agent.length) return
    const max = this.lanes.agent.max ?? this.size
    const running = this.#threads.filter((t) => t.task?.lane === 'agent')
    return running.length < max ? 'agent' : undefined
  }

  #dispatch(): void {
    for (;;) {
      const lane = this.#nextLane()
      if (!lane) return
      const thread = this.#threads.find((t) => t.ready && !t.task)
      if (!thread) {
        const starting = this.#threads.filter((t) => !t.ready).length
        const queued = this.#queues.web.length + this.#queues.agent.length
        if (
          starting < queued &&
          this.#threads.length < this.size &&
          this.#retiring < MAX_RETIRING
        )
          this.#spawn()
        return
      }
      const task = this.#queues[lane].shift()!
      thread.task = task
      task.thread = thread
      // The read's own time starts now.
      task.onStart?.()
      clearTimeout(task.timer)
      task.timer = setTimeout(
        () => this.#timeout(task),
        this.lanes[lane].timeoutMs,
      )
      thread.worker.postMessage(
        { id: task.id, op: task.op, input: task.input } satisfies PoolRequest,
        task.transfer ?? [],
      )
    }
  }

  #spawn(): void {
    const worker = new Worker(this.#options.script, {
      workerData: this.#options.workerData,
    })
    const thread: Thread = { worker, ready: false }
    worker.on('message', (response: PoolResponse) => {
      if ('log' in response) {
        this.#relay(response.log)
        return
      }
      if ('slow' in response) {
        this.#options.onSlow?.(response.slow)
        return
      }
      if ('ready' in response) {
        thread.ready = true
        this.#dispatch()
        return
      }
      const task = thread.task
      if (!task || task.id !== response.id) return
      thread.task = undefined
      clearTimeout(task.timer)
      if (response.ok) task.resolve(response.value)
      else {
        if (response.cause)
          this.#options.logger?.error(
            { op: task.op, cause: response.cause },
            'read failed',
          )
        task.reject(new ThreadError(response.error))
      }
      this.#dispatch()
    })
    // A thread that dies takes its task with it; the next one replaces it.
    const lost = (error?: Error) => {
      const at = this.#threads.indexOf(thread)
      if (at === -1) return
      this.#threads.splice(at, 1)
      const task = thread.task
      if (task) {
        clearTimeout(task.timer)
        task.reject(new PoolError('lost', 'The read thread stopped.'))
      }
      if (this.#closed) return
      this.#options.logger?.error({ err: error }, 'read thread lost')
      this.#dispatch()
    }
    worker.on('error', lost)
    worker.on('exit', () => lost())
    this.#threads.push(thread)
  }

  /** A thread's log line, written by this process's logger. */
  #relay(line: string): void {
    const logger = this.#options.logger
    if (!logger) return
    try {
      const {
        level,
        msg,
        time: _,
        pid: __,
        hostname: ___,
        ...fields
      } = JSON.parse(line) as Record<string, unknown>
      const label = logger.levels.labels[level as number] ?? 'info'
      ;(logger as unknown as Record<string, Logger['info']>)[label]?.(
        { ...fields, thread: true },
        String(msg ?? ''),
      )
    } catch {
      logger.info({ line }, 'read thread log')
    }
  }

  /** No thread took it in time: it never ran. */
  #unserved(task: Task): void {
    const queue = this.#queues[task.lane]
    queue.splice(queue.indexOf(task), 1)
    task.reject(
      new PoolError('busy', 'No reader was free in time. Retry shortly.'),
    )
  }

  /**
   * Past the deadline: answer now and end the thread, which stops once
   * SQLite returns to JavaScript; a new thread takes its place.
   */
  #timeout(task: Task): void {
    const thread = task.thread!
    const { timeoutMs } = this.lanes[task.lane]
    task.reject(
      new PoolError(
        'timeout',
        `The query took longer than ${timeoutMs / 1000} s.`,
        timeoutMs,
      ),
    )
    this.#options.logger?.warn(
      { op: task.op, lane: task.lane },
      'read timed out',
    )
    this.#threads.splice(this.#threads.indexOf(thread), 1)
    thread.task = undefined
    this.#retiring++
    thread.worker.removeAllListeners('message')
    thread.worker.removeAllListeners('exit')
    thread.worker.on('exit', () => {
      this.#retiring--
      this.#dispatch()
    })
    thread.worker.terminate().catch(() => {})
    this.#dispatch()
  }
}
