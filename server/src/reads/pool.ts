import { Worker } from 'node:worker_threads'
import { AgentError, type ErrorBody } from './errors.ts'
import { IN_FLIGHT } from './gate.ts'
import type { Logger } from '#log.ts'

/** The read threads' module. */
export const READ_THREAD = new URL('worker.ts', import.meta.url)

/** A read past this answers `query_timeout`. */
export const QUERY_TIMEOUT_MS = 5000
/**
 * Threads that timed out and may still be inside SQLite: they stop only when
 * it returns to JavaScript. Beyond this many no new thread replaces them,
 * so a run of slow queries cannot pile up threads; requests wait instead.
 */
const MAX_RETIRING = 2

/** What the main thread sends a read thread. */
export interface PoolRequest {
  id: number
  op: string
  input: unknown
}

/** What a read thread answers: first that it is ready, then each request. */
export type PoolResponse =
  | { ready: true }
  | { id: number; ok: true; value: unknown }
  /** `cause`: an unexpected error's stack, for the log. */
  | { id: number; ok: false; error: ErrorBody; cause?: string }

interface Task {
  id: number
  op: string
  input: unknown
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
  /** The thread's module; it answers `PoolRequest`s (`worker.ts`). */
  script: URL
  workerData: unknown
  size?: number
  /** How long a read may run. */
  timeoutMs?: number
  /** How long a read may wait for a thread (one starting, say). */
  waitMs?: number
  logger?: Logger
}

/**
 * Worker threads for the agent API's reads. node:sqlite is synchronous, so
 * a query on the web process's own thread would hold up every request and
 * the web app with it; here each thread has its own read-only connection.
 * One read per thread at a time; threads start with the first request.
 */
export class QueryPool {
  readonly size: number
  readonly timeoutMs: number
  readonly waitMs: number
  readonly #options: PoolOptions
  #threads: Thread[] = []
  #queue: Task[] = []
  #retiring = 0
  #next = 1
  #closed = false

  constructor(options: PoolOptions) {
    this.#options = options
    this.size = options.size ?? IN_FLIGHT
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS
    this.waitMs = options.waitMs ?? QUERY_TIMEOUT_MS
  }

  /** Threads running now, and those that timed out and are still ending. */
  get threads(): { live: number; retiring: number } {
    return { live: this.#threads.length, retiring: this.#retiring }
  }

  run(op: string, input: unknown): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new AgentError('busy', 'The server is stopping.'))
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: this.#next++,
        op,
        input,
        resolve,
        reject,
        timer: setTimeout(() => this.#unserved(task), this.waitMs),
      }
      this.#queue.push(task)
      this.#dispatch()
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const task of this.#queue.splice(0)) {
      clearTimeout(task.timer)
      task.reject(new AgentError('busy', 'The server is stopping.'))
    }
    await Promise.all(
      this.#threads.splice(0).map((thread) => thread.worker.terminate()),
    )
  }

  #dispatch(): void {
    while (this.#queue.length) {
      const thread = this.#threads.find((t) => t.ready && !t.task)
      if (!thread) {
        const starting = this.#threads.filter((t) => !t.ready).length
        if (
          starting < this.#queue.length &&
          this.#threads.length < this.size &&
          this.#retiring < MAX_RETIRING
        )
          this.#spawn()
        return
      }
      const task = this.#queue.shift()!
      thread.task = task
      task.thread = thread
      // The query's own time starts now.
      clearTimeout(task.timer)
      task.timer = setTimeout(() => this.#timeout(task), this.timeoutMs)
      thread.worker.postMessage({
        id: task.id,
        op: task.op,
        input: task.input,
      } satisfies PoolRequest)
    }
  }

  #spawn(): void {
    const worker = new Worker(this.#options.script, {
      workerData: this.#options.workerData,
    })
    const thread: Thread = { worker, ready: false }
    worker.on('message', (response: PoolResponse) => {
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
            'agent read failed',
          )
        task.reject(
          new AgentError(
            response.error.error,
            response.error.message,
            response.error.detail,
          ),
        )
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
        task.reject(new AgentError('internal', 'Internal error.'))
      }
      if (this.#closed) {
        return
      }

      this.#options.logger?.error({ err: error }, 'agent read thread lost')
      this.#dispatch()
    }
    worker.on('error', lost)
    worker.on('exit', () => lost())
    this.#threads.push(thread)
  }

  /** No thread took it in time: it never ran. */
  #unserved(task: Task): void {
    this.#queue.splice(this.#queue.indexOf(task), 1)
    task.reject(
      new AgentError('busy', 'No reader was free in time. Retry shortly.'),
    )
  }

  /**
   * Past the deadline: answer now and end the thread, which stops once
   * SQLite returns to JavaScript; a new thread takes its place.
   */
  #timeout(task: Task): void {
    const thread = task.thread!
    task.reject(
      new AgentError(
        'query_timeout',
        `The query took longer than ${this.timeoutMs / 1000} s. Narrow it (a folder, dates, an author, fewer words) and retry.`,
      ),
    )
    this.#options.logger?.warn({ op: task.op }, 'agent query timed out')
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
