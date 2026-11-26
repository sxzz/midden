// Time what the capture records page reads, on a copy of a database with
// updates (one the load test, bench-load.ts, left behind): the first page
// of `GET /v1/captures`, each update's record, an update's detail and
// members, and which statements take the time.
//
//   node scripts/bench-records.ts <db> [runs=5]
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { desc } from 'drizzle-orm'
import { recordDetail } from '#capture/records.ts'
import {
  listRecords,
  updateDetail,
  updateMembers,
  updateRecord,
} from '#capture/updates.ts'
import { openDatabase } from '#db/client.ts'
import { updates } from '#db/schema.ts'

const [file, runsArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-records.ts <db> [runs]')
  process.exit(2)
}
const RUNS = Number(runsArg ?? 5)
const db = openDatabase(file, { migrate: false, readOnly: true })

// Every statement's time, by its SQL.
const spent = new Map<string, { ms: number; n: number }>()
const client = db.$client
const prepare = client.prepare.bind(client)
client.prepare = ((text: string) => {
  const statement = prepare(text)
  for (const method of ['all', 'get', 'run'] as const) {
    const original = (statement[method] as (...a: unknown[]) => unknown).bind(
      statement,
    )
    ;(statement as unknown as Record<string, unknown>)[method] = (
      ...args: unknown[]
    ) => {
      const t = performance.now()
      try {
        return original(...args)
      } finally {
        const entry = spent.get(text) ?? { ms: 0, n: 0 }
        entry.ms += performance.now() - t
        entry.n++
        spent.set(text, entry)
      }
    }
  }
  return statement
}) as typeof client.prepare

function time(label: string, run: () => unknown) {
  run()
  spent.clear()
  const ms: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    run()
    ms.push(performance.now() - t)
  }
  ms.sort((a, b) => a - b)
  console.info(
    `${label.padEnd(40)} median ${ms[Math.floor(ms.length / 2)]!.toFixed(1).padStart(8)} ms  max ${ms.at(-1)!.toFixed(1).padStart(8)} ms`,
  )
  const top = [...spent]
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, 4)
    .filter(([, s]) => s.ms / RUNS >= 1)
  for (const [text, s] of top)
    console.info(
      `    ${(s.ms / RUNS).toFixed(1).padStart(8)} ms  ${String(s.n / RUNS).padStart(4)}×  ${text.replaceAll(/\s+/g, ' ').slice(0, 150)}`,
    )
}

const rows = db
  .select()
  .from(updates)
  .orderBy(desc(updates.createdAt))
  .limit(30)
  .all()
console.info(`${rows.length} updates; runs=${RUNS}`)
time('listRecords (first page)', () => listRecords(db))
for (const row of rows.slice(0, 3)) {
  const n = (
    client
      .prepare('SELECT count(*) AS n FROM submissions WHERE update_id = ?')
      .get(row.id) as { n: number }
  ).n
  time(`updateRecord ${row.id.slice(0, 8)} (${n} items)`, () =>
    updateRecord(db, row.id),
  )
  time(`updateDetail ${row.id.slice(0, 8)}`, () => updateDetail(db, row.id))
  time(`updateMembers ${row.id.slice(0, 8)}`, () =>
    updateMembers(db, row.id, '', undefined),
  )
}
const request = client
  .prepare(
    "SELECT id FROM submissions WHERE parent_submission IS NULL AND update_id IS NULL AND input <> '' ORDER BY created_at DESC LIMIT 1",
  )
  .get() as { id: string } | undefined
if (request)
  time(`recordDetail ${request.id.slice(0, 8)}`, () =>
    recordDetail(db, request.id),
  )
