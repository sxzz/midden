// A server process of the load test: main.ts with the fakes of fakes.ts.
// MIDDEN_ROLE picks the part it runs, as in production.
import { run } from '#runtime/run.ts'
import { benchOverrides } from './fakes.ts'

await run((config, logger) => benchOverrides(config, logger))
