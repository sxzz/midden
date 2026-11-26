import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { backup } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { pino } from 'pino'
import { mediaCommand } from '#blob/migrate.ts'
import { openR2Store } from '#blob/open.ts'
import { MediaSigner } from '#blob/signer.ts'
import { loadConfig } from '#config.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase } from '#db/client.ts'
import { maintainDatabase } from '#db/maintain.ts'
import { rawGetCommand } from '#raw/get.ts'
import { openRawStore } from '#raw/store.ts'
import { tokenCreate } from '#tokens/cli.ts'

const USAGE = `usage: node src/cli.ts <command>
  token create --ro|--rw [--label <label>] [--expires <ISO time|30m|12h|7d|never>]
  backup <directory>
  media-migrate [--dry-run] [--concurrency N] [--verify-download] [--limit N]
  media-prune-local [--dry-run] [--concurrency N] [--verify-download]
  raw-get <capture id> [position]
  maintain [--vacuum] [--rebuild-search]   (web, worker and Litestream stopped)`

function count(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) {
    console.error(USAGE)
    process.exit(1)
  }
  return n
}

// Administrative commands; run with `node src/cli.ts <command>`.
const [command, ...args] = process.argv.slice(2)
const config = loadConfig()

if (command === 'maintain') {
  // Opens the database itself, alone: before anything else does here.
  const { values } = parseArgs({
    args,
    options: {
      vacuum: { type: 'boolean' },
      'rebuild-search': { type: 'boolean' },
    },
  })
  process.exit(
    maintainDatabase(config.databasePath, {
      vacuum: values.vacuum,
      rebuildSearch: values['rebuild-search'],
      print: (line) => console.info(line),
    }),
  )
}

const db = openDatabase(config.databasePath)

if (command === 'token' && args[0] === 'create') {
  process.exitCode = tokenCreate(db, args.slice(1), {
    out: (line) => console.info(line),
    err: (line) => console.error(line),
  })
} else if (command === 'backup' && args[0]) {
  // A consistent copy of the database while the server keeps running.
  // Media files never change once written; copy them with rsync.
  mkdirSync(args[0], { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const file = path.join(args[0], `midden-${stamp}.db`)
  await backup(db.$client, file)
  console.info(file)
} else if (command === 'media-migrate' || command === 'media-prune-local') {
  if (config.media.store === 'r2') {
    const { values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        concurrency: { type: 'string' },
        'verify-download': { type: 'boolean' },
        limit: { type: 'string' },
      },
    })
    const store = await openR2Store(
      config,
      config.media.r2,
      new MediaSigner({ secret: deriveKey(config.secretKey, 'media-url') }),
      pino({ level: 'warn' }),
    )
    process.exitCode = await mediaCommand(command, db, store, {
      dryRun: values['dry-run'],
      concurrency: count(values.concurrency),
      verifyDownload: values['verify-download'],
      limit: count(values.limit),
      print: (line) => console.info(line),
    })
  } else {
    console.error(`${command} needs MEDIA_STORE=r2 and the R2 settings`)
    process.exitCode = 1
  }
} else if (command === 'raw-get' && args[0]) {
  const position = args[1] === undefined ? undefined : Number(args[1])
  if (position !== undefined && !Number.isSafeInteger(position)) {
    console.error(USAGE)
    process.exit(1)
  }
  process.exitCode = await rawGetCommand(
    db,
    await openRawStore(config, pino({ level: 'warn' })),
    args[0],
    position,
    {
      print: (line) => console.info(line),
      write: (bytes) => process.stdout.write(bytes),
    },
  )
} else {
  console.error(USAGE)
  process.exitCode = 1
}
db.$client.close()
