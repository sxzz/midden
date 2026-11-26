// A server process of the load test: main.ts with the fakes of fakes.ts.
// MIDDEN_ROLE picks the part it runs, as in production; BENCH_WAL_LOG
// turns on the WAL meter (wal-meter.ts), before run() opens the database.
import { run } from '#runtime/run.ts'
import { benchOverrides } from './fakes.ts'
import './wal-meter.ts'

await run((config, logger) => benchOverrides(config, logger))
