import process from 'node:process'
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
} else {
  console.error('usage: node src/cli.ts token create [name]')
  process.exitCode = 1
}
db.$client.close()
