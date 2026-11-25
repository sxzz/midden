import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { QueueStatus } from '#jobs/queue.ts'
import type { ThrottleState } from '#jobs/throttle.ts'

/**
 * Small JSON files in the data directory's `run/`, how the web process and
 * the worker tell each other how they are doing without touching the
 * database's write lock: the web process its recent latency (for the
 * worker's throttle), the worker its state (for the admin page).
 */
export interface Stamped {
  /** When it was written, in epoch milliseconds. */
  at: number
}

/** What the worker reports about itself (its status file, the admin page). */
export interface WorkerReport extends Stamped {
  pid: number
  startedAt: number
  throttle: ThrottleState
  queue: QueueStatus
}

/** Replace the file at once (write aside, then rename over it). */
export async function writeStatus(
  dir: string,
  name: string,
  data: object,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(data))
  await rename(temporary, file)
}

/** The file's contents, unless missing, unreadable or older than `maxAgeMs`. */
export function readStatus<T extends Stamped>(
  dir: string,
  name: string,
  maxAgeMs: number,
  now = Date.now(),
): T | undefined {
  try {
    const data = JSON.parse(
      readFileSync(path.join(dir, `${name}.json`), 'utf8'),
    ) as T
    return typeof data.at === 'number' && now - data.at <= maxAgeMs
      ? data
      : undefined
  } catch {
    return undefined
  }
}
