import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { backup } from 'node:sqlite'
import { loadConfig } from '#config.ts'
import { openDatabase } from '#db/client.ts'
import { createToken } from '#http/auth.ts'

// Administrative commands; run with `node src/cli.ts <command>`.
const [command, ...args] = process.argv.slice(2)
const config = loadConfig()
const db = openDatabase(config.databasePath)

if (command === 'token' && args[0] === 'create') {
  // Printed once: only a digest is stored.
  console.info(createToken(db, args[1] || 'api'))
} else if (command === 'backup' && args[0]) {
  // A consistent copy of the database while the server keeps running.
  // Media files never change once written; copy them with rsync.
  mkdirSync(args[0], { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const file = path.join(args[0], `midden-${stamp}.db`)
  await backup(db.$client, file)
  console.info(file)
} else {
  console.error(
    'usage: node src/cli.ts token create [name] | backup <directory>',
  )
  process.exitCode = 1
}
db.$client.close()
