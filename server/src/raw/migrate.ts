import { and, asc, gt, isNull, lte, sql } from 'drizzle-orm'
import { formatBytes } from '#blob/migrate.ts'
import { sourceResponses } from '#db/schema.ts'
import { captureResponses, markStored, sourceBody } from './responses.ts'
import { CorruptRawError, pack, type RawStore } from './store.ts'
import type { Database } from '#db/client.ts'
import type { Buffer } from 'node:buffer'

export interface RawMigrateOptions {
  dryRun?: boolean
  /** Bodies stored at once. */
  concurrency?: number
  /** Stop after this many raw responses. */
  limit?: number
  print: (line: string) => void
  now?: () => number
}

export interface RawMigrateSummary {
  /** Raw responses still in the database that were looked at. */
  responses: number
  bytes: number
  /** Their size compressed, as stored (or, in a dry run, as it would be). */
  compressed: number
  /** Stored in the bucket and read back. */
  stored: number
  /** Recorded as in the bucket, their bodies cleared here. */
  marked: number
  /** Recorded by the server meanwhile, or deleted (pruned) meanwhile. */
  meanwhile: number
  /** Not what their hash says; left as they are. */
  corrupt: number
  failed: number
}

const PAGE = 200
const PROGRESS_MS = 5000
// The server stores what its captures fetch; leave it the newest rows, so
// that no row this run stores can be newer than a garbage check the server
// started (see `collectRawGarbage`): such a check deletes an object only
// when no row uses it, and these rows all existed before it.
const SETTLED_MS = 10 * 60_000
// Bodies cleared in one transaction: stored ones wait at most this long.
const MARK_BATCH = 100
const MARK_EVERY_MS = 1000

type Row = { id: string; sha256: string; body: Buffer; size: number }

async function* localRows(
  db: Database,
  before: Date,
  limit = Infinity,
): AsyncGenerator<Row> {
  let last = ''
  let count = 0
  for (;;) {
    const rows = db
      .select({
        id: sourceResponses.id,
        sha256: sourceResponses.sha256,
        body: sourceResponses.body,
        size: sourceResponses.size,
      })
      .from(sourceResponses)
      .where(
        and(
          isNull(sourceResponses.remoteAt),
          lte(sourceResponses.createdAt, before),
          gt(sourceResponses.id, last),
        ),
      )
      .orderBy(asc(sourceResponses.id))
      .limit(PAGE)
      .all()
    if (!rows.length) return
    for (const row of rows) {
      if (count++ >= limit) return
      yield row
    }
    last = rows.at(-1)!.id
  }
}

/**
 * Move the raw responses still in the database to the raw bucket
 * (`raw-migrate`), as the server's upload job does for new captures: each
 * body is compressed, stored, read back, and only then recorded and cleared
 * here. Nothing is lost when it stops at any point: a body stored but not
 * recorded is stored again next time (same key, same bytes). Runs beside
 * the server; rows the server is busy with are left to it.
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
    responses: 0,
    bytes: 0,
    compressed: 0,
    stored: 0,
    marked: 0,
    meanwhile: 0,
    corrupt: 0,
    failed: 0,
  }
  const left = db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(sourceResponses)
    .where(
      and(
        isNull(sourceResponses.remoteAt),
        lte(sourceResponses.createdAt, before),
      ),
    )
    .get()!.n
  const total = Math.min(left, options.limit ?? Infinity)
  print(
    `${dryRun ? '[dry run] ' : ''}${total} raw responses in the database to move`,
  )

  let pending: Row[] = []
  let flushedAt = now()
  const flush = () => {
    if (!pending.length) return
    const rows = pending
    pending = []
    flushedAt = now()
    const marked = markStored(db, rows, new Date(now()))
    summary.marked += marked
    summary.meanwhile += rows.length - marked
  }
  let reported = now()
  const report = (force = false) => {
    if (!force && now() - reported < PROGRESS_MS) return
    reported = now()
    print(
      `${summary.responses}/${total} checked, ${summary.stored} stored (${formatBytes(summary.bytes)} → ${formatBytes(summary.compressed)}), ${summary.marked} recorded, ${summary.failed + summary.corrupt} problems`,
    )
  }

  const one = async (row: Row) => {
    summary.responses++
    summary.bytes += row.body.length
    try {
      if (dryRun) {
        summary.compressed += pack(row.body, row.sha256).bytes.length
        return
      }
      // Not `+= await`: that reads the total before other workers add to it.
      const stored = await raw!.put(row.sha256, row.body)
      summary.compressed += stored
      summary.stored++
      pending.push(row)
      if (pending.length >= MARK_BATCH || now() - flushedAt >= MARK_EVERY_MS)
        flush()
    } catch (error) {
      if (error instanceof CorruptRawError) summary.corrupt++
      else summary.failed++
      print(`failed ${row.id} (${row.sha256}): ${(error as Error).message}`)
    } finally {
      report()
    }
  }

  const rows = localRows(db, before, options.limit)
  const worker = async () => {
    for (;;) {
      const next = await rows.next()
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
      `${prefix}checked ${s.responses} raw responses (${formatBytes(s.bytes)}, ${formatBytes(s.compressed)} compressed)`,
      `stored ${s.stored}, recorded and cleared ${s.marked}${s.meanwhile ? ` (and ${s.meanwhile} recorded or deleted by the server meanwhile)` : ''}`,
      `not matching their hash ${s.corrupt}, failed ${s.failed}`,
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
