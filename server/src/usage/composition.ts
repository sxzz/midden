import { statSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { eq, sql } from 'drizzle-orm'
import { latestMigration, type Database } from '#db/client.ts'
import { settings } from '#db/schema.ts'
import { readSetting, writeSetting } from '#settings.ts'
import type {
  CompositionInput,
  CompositionItem,
  CompositionOutput,
} from './composition-worker.ts'

/** The last reading, kept in `settings` as JSON. */
const KEY = 'db_composition'
/** The page's request to read it now; see `CompositionJob`. */
const JOB = 'db_composition_job'
/** When something changed the database a lot: `{ at }`, the time it was marked. */
const STALE = 'db_composition_stale'
/** Read once a day. */
export const COMPOSITION_INTERVAL = 24 * 60 * 60_000
/** A request or a reading that old is taken for lost (the worker died). */
export const JOB_TTL = 15 * 60_000
/** The file growing or shrinking by this much since the reading is a change. */
const SIZE_CHANGE = 0.1
/** The page lists this many of the largest b-trees and sums the rest. */
const TOP = 15

export interface Composition {
  computed_at: string
  /** Seconds the reading took. */
  seconds: number
  total_bytes: number
  /**
   * What the reading was taken on: the newest applied migration and the
   * size of the database file, to tell later when it no longer fits.
   */
  migration?: string
  file_bytes?: number
  /** The largest tables and indexes, largest first. */
  items: CompositionItem[]
  /** What the rest add up to. */
  rest: { count: number; bytes: number }
  /** Every file under the media directory: thumbnails and pending uploads. */
  media: { files: number; bytes: number }
}

export function storedComposition(db: Database): Composition | undefined {
  const text = readSetting(db, KEY)
  if (!text) return undefined
  try {
    return JSON.parse(text) as Composition
  } catch {
    return undefined
  }
}

/** Read the database's composition in a worker thread. */
export function readComposition(
  input: CompositionInput,
): Promise<CompositionOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('composition-worker.ts', import.meta.url),
      { workerData: input },
    )
    let settled = false
    worker.once('message', (output: CompositionOutput) => {
      settled = true
      resolve(output)
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled)
        reject(new Error(`composition worker exited with code ${code}`))
    })
  })
}

/** Read the composition and keep it; returns what was stored. */
export async function recordComposition(
  db: Database,
  input: CompositionInput,
  now = Date.now,
  read = readComposition,
): Promise<Composition> {
  const started = now()
  const fileBytes = fileBytesOf(input.databasePath)
  const output = await read(input)
  const rest = output.items.slice(TOP)
  const composition: Composition = {
    computed_at: new Date(now()).toISOString(),
    seconds: Math.round((now() - started) / 100) / 10,
    total_bytes: output.total_bytes,
    ...(latestMigration(db) ? { migration: latestMigration(db) } : {}),
    file_bytes: fileBytes,
    items: output.items.slice(0, TOP),
    rest: {
      count: rest.length,
      bytes: rest.reduce((sum, item) => sum + item.bytes, 0),
    },
    media: output.media,
  }
  writeSetting(db, KEY, JSON.stringify(composition))
  // A mark made before this reading started is answered by it.
  clearUnlessAfter(db, STALE, started)
  return composition
}

function fileBytesOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** Why the stored reading should be taken again; undefined when it fits. */
export type CompositionReason =
  'missing' | 'old' | 'marked' | 'migrations' | 'size'

/**
 * Why the stored reading is out of date, if it is: none yet, a day old,
 * marked by offline maintenance, taken on other migrations (a deploy that
 * rebuilt tables), or on a file whose size has since changed by 10%.
 */
export function compositionReason(
  db: Database,
  now: number,
  databasePath: string,
): CompositionReason | undefined {
  const stored = storedComposition(db)
  const at = Date.parse(stored?.computed_at ?? '')
  if (!stored || !Number.isFinite(at)) return 'missing'
  if (now - at >= COMPOSITION_INTERVAL) return 'old'
  if (readSetting(db, STALE)) return 'marked'
  if (stored.migration !== latestMigration(db)) return 'migrations'
  const bytes = fileBytesOf(databasePath)
  if (
    bytes > 0 &&
    stored.file_bytes &&
    Math.abs(bytes - stored.file_bytes) / stored.file_bytes > SIZE_CHANGE
  )
    return 'size'
}

/** Whether the stored reading is a day old, or missing. */
export function compositionDue(db: Database, now: number): boolean {
  const at = Date.parse(storedComposition(db)?.computed_at ?? '')
  return !Number.isFinite(at) || now - at >= COMPOSITION_INTERVAL
}

/** Offline maintenance rewrote the database: read it again soon. */
export function markCompositionStale(db: Database, now = Date.now()): void {
  writeSetting(db, STALE, JSON.stringify({ at: new Date(now).toISOString() }))
}

/** The page asked for a reading now; the worker takes it up. */
export interface CompositionJob {
  state: 'queued' | 'running'
  /** When it was asked for. */
  at: string
}

/** The request in flight, if any; one the worker never answered is gone. */
export function compositionJob(
  db: Database,
  now: number,
): CompositionJob | null {
  const text = readSetting(db, JOB)
  if (!text) return null
  try {
    const job = JSON.parse(text) as CompositionJob
    const at = Date.parse(job.at)
    return Number.isFinite(at) && now - at < JOB_TTL ? job : null
  } catch {
    return null
  }
}

/**
 * Ask the worker for a reading now. Idempotent: while one is queued or
 * running the existing request stands, and the write is a single statement,
 * so two clicks from two processes cannot queue two.
 */
export function requestComposition(db: Database, now: number): CompositionJob {
  const job: CompositionJob = {
    state: 'queued',
    at: new Date(now).toISOString(),
  }
  const expired = new Date(now - JOB_TTL).toISOString()
  db.insert(settings)
    .values({ key: JOB, value: JSON.stringify(job) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(job) },
      setWhere: sql`json_extract(${settings.value}, '$.at') IS NULL OR json_extract(${settings.value}, '$.at') <= ${expired}`,
    })
    .run()
  return compositionJob(db, now) ?? job
}

/** The worker has taken the request up. */
export function startComposition(db: Database, job: CompositionJob): void {
  writeSetting(db, JOB, JSON.stringify({ ...job, state: 'running' }))
}

/**
 * The reading started at `started` is done: a request made before it is
 * answered, one made during it waits for the next.
 */
export function finishComposition(db: Database, started: number): void {
  clearUnlessAfter(db, JOB, started)
}

function clearUnlessAfter(db: Database, key: string, started: number): void {
  const text = readSetting(db, key)
  if (!text) return
  let at = NaN
  try {
    at = Date.parse((JSON.parse(text) as { at?: string }).at ?? '')
  } catch {}
  if (!(at > started)) db.delete(settings).where(eq(settings.key, key)).run()
}
