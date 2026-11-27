#!/usr/bin/env node
import process from 'node:process'
import { pino } from 'pino'
import { openR2Store } from '#blob/open.ts'
import { MediaSigner } from '#blob/signer.ts'
import { loadConfig } from '#config.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase, type Database } from '#db/client.ts'
import { openRawStore } from '#raw/store.ts'
import { runCli } from './cli/program.ts'

// Administrative commands: `node src/cli.ts <command>`, or `midden <command>`
// in the image. Data goes to stdout, everything else to stderr, so output can
// be piped; pino writes to stdout by default, so its destination is set.
const logger = () => pino({ level: 'warn' }, pino.destination(2))
let db: Database | undefined
let config: ReturnType<typeof loadConfig> | undefined
const getConfig = () => (config ??= loadConfig())

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    // Not console.info: the parser's help output is routed through out.
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => console.error(line),
    write: (bytes) => process.stdout.write(bytes),
    config: getConfig,
    db: () => (db ??= openDatabase(getConfig().databasePath)),
    mediaStore: () => {
      const { media } = getConfig()
      return media.store === 'r2'
        ? openR2Store(
            getConfig(),
            media.r2,
            new MediaSigner({
              secret: deriveKey(getConfig().secretKey, 'media-url'),
            }),
            logger(),
          )
        : Promise.resolve(undefined)
    },
    rawStore: () => openRawStore(getConfig(), logger()),
    now: Date.now,
    version: process.env.BUILD_REVISION || 'dev',
  })
} catch (error) {
  // A bad configuration or an unexpected failure: the message, not a stack.
  console.error(`midden: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  db?.$client.close()
}
