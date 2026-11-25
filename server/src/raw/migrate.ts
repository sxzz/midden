import { setTimeout as sleep } from 'node:timers/promises'
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { formatBytes } from '#blob/migrate.ts'
import { sourceResponses } from '#db/schema.ts'
import { captureResponses, markStoredKeys, sourceBody } from './responses.ts'
import {
  CorruptRawError,
  pack,
  RawRateLimitError,
  type RawStore,
} from './store.ts'
import type { Database } from '#db/client.ts'
import type { Buffer } from 'node:buffer'

export interface RawMigrateOptions {
  dryRun?: boolean
  /** Objects stored at once; never two of one key. */
  concurrency?: number
  /** Stop after this many objects (each with every row holding it). */
  limit?: number
  print: (line: string) => void
  now?: () => number
}

export interface RawMigrateSummary {
  /** Distinct bodies (objects) still in the database that were looked at. */
  objects: number
  /** The raw responses holding them. */
  responses: number
  /** Their size, each body once. */
  bytes: number
  /** That compressed, as stored (or, in a dry run, as it would be). */
  compressed: number
  /** Uploaded and read back. */
  uploaded: number
  /** Already in the bucket and reading back right: kept, not uploaded. */
  present: number
  /** Rows recorded as in the bucket, their bodies cleared here. */
  marked: number
  /** Rows recorded by the server meanwhile, or deleted (pruned) meanwhile. */
  meanwhile: number
  /** Times the bucket rate-limited the run, which then waited. */
  pauses: number
  /** Objects whose body is not what its hash says; their rows stay. */
  corrupt: number
  /** Objects that failed; their rows stay. */
  failed: number
}

const PAGE = 200
const PROGRESS_MS = 5000
// The server stores what its captures fetch; leave it the newest rows, so
// that no object this run stores can be for a row newer than a garbage
// check the server started (see `collectRawGarbage`): such a check deletes
// an object only when no row uses it, and these rows all existed before it.
const SETTLED_MS = 10 * 60_000
// Rows cleared in one transaction: stored ones wait at most this long.
const MARK_BATCH = 100
const MARK_EVERY_MS = 1000

type Key = { sha256: string; rows: number; bytes: number }

/** Distinct bodies of settled rows still here, by hash. */
async function* localKeys(
  db: Database,
  before: Date,
  limit = Infinity,
): AsyncGenerator<Key> {
  let last = ''
  let count = 0
  for (;;) {
    const keys = db
      .select({
        sha256: sourceResponses.sha256,
        rows: sql<number>`count(*)`.mapWith(Number),
        bytes: sql<number>`max(${sourceResponses.size})`.mapWith(Number),
      })
      .from(sourceResponses)
      .where(
        and(
          isNull(sourceResponses.remoteAt),
          lte(sourceResponses.createdAt, before),
          gt(sourceResponses.sha256, last),
        ),
      )
      .groupBy(sourceResponses.sha256)
      .orderBy(asc(sourceResponses.sha256))
      .limit(PAGE)
      .all()
    if (!keys.length) return
    for (const key of keys) {
      if (count++ >= limit) return
      yield key
    }
    last = keys.at(-1)!.sha256
  }
}

/** One row's body of this hash still here, if any is left. */
function localBody(db: Database, sha256: string): Buffer | undefined {
  return db
    .select({ body: sourceResponses.body })
    .from(sourceResponses)
    .where(
      and(eq(sourceResponses.sha256, sha256), isNull(sourceResponses.remoteAt)),
    )
    .get()?.body
}

/**
 * Move the raw responses still in the database to the raw bucket
 * (`raw-migrate`), as the server's upload job does for new captures. The
 * work goes by body: each distinct one is compressed, checked against an
 * object already in the bucket (kept when it reads back right) or else
 * uploaded and read back, and only then every row holding it is recorded
 * and cleared, in one transaction. Workers take distinct keys, so no key is
 * written twice at once: R2 rejects writes to one key faster than about one
 * a second. When the bucket rate-limits anyway, the whole run waits for it.
 * Nothing is lost when it stops at any point: an object stored but not yet
 * recorded is found and kept next time. Runs beside the server; rows the
 * server is busy with are left to it.
 */
export async function migrateRaw(
  db: Database,
  raw: RawStore | undefined,
  options: RawMigrateOptions,
): Promise<RawMigrateSummary> {
  const { print } = options
  const dryRun = !!options.dryRun
  if (!raw && !dryRun) throw new Error('raw-migrate needs the raw bucket')
  const now = () => options.now?.() ?? Date.now()
  const before = new Date(now() - SETTLED_MS)
  const summary: RawMigrateSummary = {
    objects: 0,
    responses: 0,
    bytes: 0,
    compressed: 0,
    uploaded: 0,
    present: 0,
    marked: 0,
    meanwhile: 0,
    pauses: 0,
    corrupt: 0,
    failed: 0,
  }
  const left = db
    .select({
      rows: sql<number>`count(*)`.mapWith(Number),
      keys: sql<number>`count(DISTINCT ${sourceResponses.sha256})`.mapWith(
        Number,
      ),
    })
    .from(sourceResponses)
    .where(
      and(
        isNull(sourceResponses.remoteAt),
        lte(sourceResponses.createdAt, before),
      ),
    )
    .get()!
  const total = Math.min(left.keys, options.limit ?? Infinity)
  print(
    `${dryRun ? '[dry run] ' : ''}${left.rows} raw responses in the database to move, ${left.keys} distinct bodies`,
  )

  // Stored keys and their rows, recorded together.
  let pending: Key[] = []
  let flushedAt = now()
  const flush = () => {
    if (!pending.length) return
    const keys = pending
    pending = []
    flushedAt = now()
    const marked = markStoredKeys(
      db,
      keys.map((key) => key.sha256),
      new Date(now()),
    )
    summary.marked += marked
    summary.meanwhile += Math.max(
      keys.reduce((n, key) => n + key.rows, 0) - marked,
      0,
    )
  }
  let reported = now()
  const report = (force = false) => {
    if (!force && now() - reported < PROGRESS_MS) return
    reported = now()
    print(
      `${summary.objects}/${total} bodies checked, ${summary.uploaded} uploaded and ${summary.present} already there (${formatBytes(summary.bytes)} → ${formatBytes(summary.compressed)}), ${summary.marked} rows recorded, ${summary.failed + summary.corrupt} problems`,
    )
  }

  /** Store one key, waiting out the bucket's rate limits. */
  const store = async (key: Key, body: Buffer): Promise<void> => {
    for (;;) {
      try {
        const stored = await raw!.store(key.sha256, body, { check: true })
        if (stored.uploaded) summary.uploaded++
        else summary.present++
        summary.compressed += stored.bytes
        return
      } catch (error) {
        if (!(error instanceof RawRateLimitError)) throw error
        if (error.started) {
          summary.pauses++
          print(
            `the bucket is rate-limiting; waiting ${Math.ceil(error.afterMs / 1000)} s`,
          )
        }
        await sleep(error.afterMs)
      }
    }
  }

  const one = async (key: Key) => {
    summary.objects++
    summary.responses += key.rows
    try {
      const body = localBody(db, key.sha256)
      // The server recorded them meanwhile, or they were pruned.
      if (!body) {
        summary.meanwhile += key.rows
        return
      }
      summary.bytes += body.length
      if (dryRun) {
        summary.compressed += pack(body, key.sha256).bytes.length
        return
      }
      await store(key, body)
      pending.push(key)
      if (
        pending.reduce((n, k) => n + k.rows, 0) >= MARK_BATCH ||
        now() - flushedAt >= MARK_EVERY_MS
      )
        flush()
    } catch (error) {
      if (error instanceof CorruptRawError) summary.corrupt++
      else summary.failed++
      print(
        `failed ${key.sha256} (${key.rows} rows): ${(error as Error).message}`,
      )
    } finally {
      report()
    }
  }

  const keys = localKeys(db, before, options.limit)
  const worker = async () => {
    for (;;) {
      const next = await keys.next()
      if (next.done) return
      await one(next.value)
    }
  }
  try {
    await Promise.all(
      Array.from({ length: Math.max(options.concurrency ?? 4, 1) }, worker),
    )
  } finally {
    flush()
  }
  report(true)
  return summary
}

/** Run `raw-migrate`; the exit code. */
export async function rawMigrateCommand(
  db: Database,
  raw: RawStore | undefined,
  options: RawMigrateOptions,
): Promise<number> {
  const s = await migrateRaw(db, raw, options)
  const prefix = options.dryRun ? '[dry run] ' : ''
  options.print(
    [
      `${prefix}checked ${s.objects} distinct bodies of ${s.responses} raw responses (${formatBytes(s.bytes)}, ${formatBytes(s.compressed)} compressed)`,
      `uploaded ${s.uploaded}, already in the bucket ${s.present}, rows recorded and cleared ${s.marked}${s.meanwhile ? ` (and ${s.meanwhile} recorded or deleted by the server meanwhile)` : ''}`,
      `rate-limit pauses ${s.pauses}, not matching their hash ${s.corrupt}, failed ${s.failed}`,
    ].join('\n'),
  )
  return s.corrupt + s.failed ? 1 : 0
}

/**
 * `raw-get <capture> [position]`: a capture's raw responses, or one body
 * written out as fetched, wherever it is kept.
 */
export async function rawGetCommand(
  db: Database,
  raw: RawStore | undefined,
  captureId: string,
  position: number | undefined,
  out: { print: (line: string) => void; write: (bytes: Buffer) => void },
): Promise<number> {
  const rows = captureResponses(db, captureId)
  if (position === undefined) {
    if (!rows.length) out.print(`no raw responses for capture ${captureId}`)
    for (const row of rows)
      out.print(
        `${row.position}\t${row.remoteAt ? 'bucket' : 'database'}\t${row.size}\t${row.contentType}\t${row.sourceUrl}`,
      )
    return rows.length ? 0 : 1
  }
  const row = rows.find((r) => r.position === position)
  if (!row) {
    out.print(`no raw response ${position} for capture ${captureId}`)
    return 1
  }
  out.write(await sourceBody(raw, row))
  return 0
}
