// `listFolders` on a database with folders, with a cold cache: how long it
// takes and the longest stretch the event loop was blocked meanwhile.
//
//   node scripts/bench-folders-cold.ts <db> [runs=5]
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { openDatabase } from '#db/client.ts'
import { listFolders } from '#library/folders.ts'

const [file, runs = '5'] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-folders-cold.ts <db> [runs]')
  process.exit(2)
}
const db = openDatabase(file, { migrate: false })
const writer = openDatabase(file, { migrate: false })
const totals: number[] = []
const stalls: number[] = []
for (let i = 0; i < Number(runs); i++) {
  // Another connection's write starts the counts over, as the worker's do.
  writer.$client.exec('UPDATE tags SET name = name')
  let last = performance.now()
  let longest = 0
  const probe = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  const at = performance.now()
  const folders = await listFolders(db)
  totals.push(performance.now() - at)
  clearInterval(probe)
  longest = Math.max(longest, performance.now() - last)
  stalls.push(longest)
  if (i === 0) console.log(`${folders.length} folders`)
}
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
console.log(
  `listFolders median ${median(totals).toFixed(0)} ms, longest block median ${median(stalls).toFixed(0)} ms (max ${Math.max(...stalls).toFixed(0)})`,
)
