// A server process of the load test: main.ts with the fakes of fakes.ts.
// MIDDEN_ROLE picks the part it runs, as in production; BENCH_WAL_LOG
// turns on the WAL meter (wal-meter.ts), before run() opens the database.
// BENCH_LAG_LOG: where the web process writes its event-loop delay, the
// longest stall of each second, when it exits.
import { writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import process from 'node:process'
import { run } from '#runtime/run.ts'
import { benchOverrides } from './fakes.ts'
import './wal-meter.ts'

const lagLog = process.env.BENCH_LAG_LOG
if (lagLog && process.env.MIDDEN_ROLE !== 'worker') {
  const seconds: { at: number; max: number }[] = []
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  setInterval(() => {
    if (histogram.count)
      seconds.push({ at: Date.now(), max: histogram.max / 1e6 })
    histogram.reset()
  }, 1000).unref()
  process.on('exit', () => writeFileSync(lagLog, JSON.stringify(seconds)))
}

await run((config, logger) => benchOverrides(config, logger))
