// Time the capture records list as the web app polls it, in one process, on
// a copy of a database with large updates (the newest being in progress),
// as a read thread answers it: records kept between polls, `forget` on a
// write.
//
//   node scripts/bench-poll.ts <db> [polls=40]
//
// Times are CPU milliseconds of this thread.
// Polls come 2.5 s apart on a simulated clock (what the kept records and
// the summaries age by). Reported: the first page of `GET /v1/captures`
// (`listRecords`) without any write, and with a write announced before
// every poll (an update writes all the time: the worst case), and the
// detail (`updateDetail`) of a finished and of the running update. With
// `write=1` the copy is written to: the worker's sweep writes the finished
// records down first (`refreshSummaries`), which is timed.
import process from 'node:process'
import { desc } from 'drizzle-orm'
import { forgetRecords, keepFinishedRecords } from '#capture/record-cache.ts'
import { listRecords, updateDetail } from '#capture/updates.ts'
import { openDatabase } from '#db/client.ts'
import { updates } from '#db/schema.ts'

const [file, pollsArg, ...rest] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-poll.ts <db> [polls] [write=1]')
  process.exit(2)
}
const POLLS = Number(pollsArg ?? 40)
const write = rest.includes('write=1')
const db = openDatabase(file, { migrate: write, readOnly: !write })

// CPU time rather than wall time: the machine is shared, and everything
// measured here runs on the calling thread.
const cpu = () => {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

let clock = Date.now()
Date.now = () => clock
const POLL_EVERY = 2500

function quantiles(ms: number[]) {
  const sorted = ms.toSorted((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return `p50 ${at(0.5).toFixed(1).padStart(8)} ms  p95 ${at(0.95).toFixed(1).padStart(8)} ms  max ${sorted.at(-1)!.toFixed(1).padStart(8)} ms`
}

function polls(label: string, afterEach: () => void) {
  keepFinishedRecords()
  const ms: number[] = []
  for (let i = 0; i < POLLS; i++) {
    clock += POLL_EVERY
    afterEach()
    const t = cpu()
    listRecords(db)
    ms.push(cpu() - t)
  }
  keepFinishedRecords(false)
  console.info(`${label.padEnd(42)} ${quantiles(ms)}`)
}

const first = listRecords(db).items
console.info(
  `${first.length} records on the first page, ${first.filter((r) => !r.done).length} in progress, members of the first: ${first[0]?.members?.total}`,
)

if (write) {
  const { refreshSummaries } = await import('#capture/summary-sweep.ts')
  const worker = { db }
  const ctx = worker as Parameters<typeof refreshSummaries>[0]
  const t = cpu()
  let written = 0
  for (let n = 1; n;) {
    n = refreshSummaries(ctx, { budgetMs: 1e9 })
    written += n
  }
  console.info(
    `sweep wrote ${written} records down in ${((cpu() - t) / 1000).toFixed(1)} s of CPU`,
  )
}

polls('list, polls only', () => {})
polls('list, a write before every poll', forgetRecords)

const rows = db
  .select()
  .from(updates)
  .orderBy(desc(updates.createdAt))
  .limit(30)
  .all()
for (const [label, row] of [
  ['detail, finished update', rows.find((r) => r.state !== 'running')],
  ['detail, update in progress', rows.find((r) => r.state === 'running')],
] as const) {
  if (!row) continue
  keepFinishedRecords()
  const cold: number[] = []
  const warm: number[] = []
  for (let i = 0; i < 10; i++) {
    clock += POLL_EVERY
    forgetRecords()
    let t = cpu()
    updateDetail(db, row.id)
    cold.push(cpu() - t)
    t = cpu()
    updateDetail(db, row.id)
    warm.push(cpu() - t)
  }
  keepFinishedRecords(false)
  console.info(`${`${label} (counted)`.padEnd(42)} ${quantiles(cold)}`)
  console.info(`${`${label} (kept)`.padEnd(42)} ${quantiles(warm)}`)
}
