#!/usr/bin/env node
// Back up the deployment in MIDDEN_DIR (default ~/midden): a consistent
// database snapshot with .env, kept per day, and a mirror of the media,
// which never change once written, so the mirror plus any snapshot restores
// completely. Run daily by the LaunchAgent from install-backup.ts.
//
//   node scripts/backup.ts [--to ~/backups/midden/auto] [--keep-days 7]
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, parseEnv } from 'node:util'
import { createGzip } from 'node:zlib'

const DAY = 24 * 60 * 60_000

const { values } = parseArgs({
  options: {
    to: {
      type: 'string',
      default: path.join(homedir(), 'backups', 'midden', 'auto'),
    },
    'keep-days': { type: 'string', default: '7' },
  },
})
const dir = path.resolve(
  process.env.MIDDEN_DIR || path.join(homedir(), 'midden'),
)
const target = path.resolve(values.to)
const keepDays = Number(values['keep-days'])

let env: Record<string, string | undefined> = {}
try {
  env = parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'))
} catch {}
const dataDir = path.resolve(dir, env.DATA_PATH || 'data')

function run(command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

function step(message: string) {
  console.info(`== ${new Date().toISOString()} ${message}`)
}

/** Let a running deployment finish: the server restarts during it. */
async function waitForDeployment() {
  const lock = path.join(dir, '.local', 'deploy.lock')
  for (let i = 0; existsSync(lock); i++) {
    if (i === 180) throw new Error(`${lock} held for 30 minutes`)
    await sleep(10_000)
  }
}

/** Copy the database with the server's online backup and check the copy. */
function snapshot(): string {
  const inside = run('docker', [
    'compose',
    'exec',
    '-T',
    'midden',
    'node',
    'server/src/cli.ts',
    'backup',
    '/data/backups/daily',
  ])
  const file = path.join(dataDir, 'backups', 'daily', path.basename(inside))
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const result = db.prepare('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok')
      throw new Error(`snapshot failed the integrity check: ${file}`)
  } finally {
    db.close()
  }
  return file
}

async function notify(text: string) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chat = env.DEPLOY_NOTIFY_CHAT_ID || env.OWNER_TELEGRAM_ID
  if (!token || !chat) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }),
    })
  } catch {}
}

async function backup() {
  await waitForDeployment()
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const daily = path.join(target, 'daily')
  const partial = path.join(daily, `${stamp}.partial`)
  mkdirSync(partial, { recursive: true })

  step('database')
  try {
    const file = snapshot()
    try {
      await pipeline(
        createReadStream(file),
        createGzip(),
        createWriteStream(path.join(partial, 'midden.db.gz')),
      )
    } finally {
      rmSync(file, { force: true })
    }
    // SECRET_KEY in .env decrypts the stored account credentials.
    copyFileSync(path.join(dir, '.env'), path.join(partial, '.env'))
    writeFileSync(
      path.join(partial, 'revision'),
      `${run('git', ['rev-parse', 'HEAD'])}\n`,
    )
    renameSync(partial, path.join(daily, stamp))
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }

  // After the snapshot: media are written before the rows that use them.
  step('media')
  mkdirSync(path.join(target, 'media'), { recursive: true })
  run('rsync', [
    '-a',
    `${path.join(dataDir, 'media')}/`,
    `${path.join(target, 'media')}/`,
  ])

  // Prune only after a successful backup, and never the newest one.
  const days = readdirSync(daily)
    .filter((name) => !name.endsWith('.partial'))
    .toSorted()
  const cutoff = Date.now() - keepDays * DAY
  for (const name of days.slice(0, -1)) {
    const at = Date.parse(
      name.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z$/, 'T$1:$2:$3.$4Z'),
    )
    if (at < cutoff) {
      rmSync(path.join(daily, name), { recursive: true, force: true })
      console.info(`removed ${name}`)
    }
  }
  const size = run('du', ['-sh', path.join(daily, stamp)]).split('\t', 1)[0]
  step(`done: ${path.join(daily, stamp)} (${size})`)
}

process.umask(0o077)
try {
  await backup()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  await notify(`❌ midden 备份失败\n${message}`)
  process.exitCode = 1
}
