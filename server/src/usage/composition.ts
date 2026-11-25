import { Worker } from 'node:worker_threads'
import { readSetting, writeSetting } from '#settings.ts'
import type { Database } from '#db/client.ts'
import type {
  CompositionInput,
  CompositionItem,
  CompositionOutput,
} from './composition-worker.ts'

/** The last reading, kept in `settings` as JSON. */
const KEY = 'db_composition'
/** Read once a day. */
export const COMPOSITION_INTERVAL = 24 * 60 * 60_000
/** The page lists this many of the largest b-trees and sums the rest. */
const TOP = 15

export interface Composition {
  computed_at: string
  /** Seconds the reading took. */
  seconds: number
  total_bytes: number
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
  const output = await read(input)
  const rest = output.items.slice(TOP)
  const composition: Composition = {
    computed_at: new Date(now()).toISOString(),
    seconds: Math.round((now() - started) / 100) / 10,
    total_bytes: output.total_bytes,
    items: output.items.slice(0, TOP),
    rest: {
      count: rest.length,
      bytes: rest.reduce((sum, item) => sum + item.bytes, 0),
    },
    media: output.media,
  }
  writeSetting(db, KEY, JSON.stringify(composition))
  return composition
}

/** Whether the stored reading is a day old, or missing. */
export function compositionDue(db: Database, now: number): boolean {
  const at = Date.parse(storedComposition(db)?.computed_at ?? '')
  return !Number.isFinite(at) || now - at >= COMPOSITION_INTERVAL
}
