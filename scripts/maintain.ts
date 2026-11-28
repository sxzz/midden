#!/usr/bin/env node
// Offline maintenance of the database on the deploy host, in the checkout in
// MIDDEN_DIR (default ~/midden, /opt/midden for root on Linux): stop the
// running version and Litestream as a deployment does, run `cli.ts maintain`
// in that version's image, then start Litestream, the web process and the
// worker again in a deployment's order. Holds the deploy lock meanwhile.
// See docs/operations.md, 数据库维护.
//
//   node scripts/maintain.ts [--no-vacuum] [--rebuild-search]

/* eslint-disable unicorn/no-exports-in-scripts -- for maintain.test.ts */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { deploymentDir, services, type Run } from './deploy.ts'

const IMAGE = 'ghcr.io/sxzz/midden'

export interface MaintainOptions {
  /** Leave out the vacuum: checks, search indexes and statistics only. */
  vacuum?: boolean
  rebuildSearch?: boolean
  /** Blocks between health checks; tests pass a recorder. */
  sleep?: (ms: number) => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Maintain the database of the running version; returns the result line. */
export function maintain(
  dir: string,
  run: Run,
  { vacuum = true, rebuildSearch = false, sleep }: MaintainOptions = {},
): string {
  const { runningRevision, settings, start, stopAll } = services(
    dir,
    run,
    sleep,
  )
  const current = runningRevision()
  if (!current)
    throw new Error('no version is running; maintain the one that runs')
  const { dataDir, litestream } = settings()

  console.info(`== stopping ${current}`)
  stopAll(litestream)
  let failure = ''
  try {
    console.info('== maintaining the database')
    // The version that ran it, so its migrations are the database's. The
    // command refuses to start while anything else has the database open.
    const output = run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'midden',
        'node',
        'server/src/cli.ts',
        'maintain',
        ...(vacuum ? ['--vacuum'] : []),
        ...(rebuildSearch ? ['--rebuild-search'] : []),
      ],
      { MIDDEN_IMAGE: `${IMAGE}:sha-${current}` },
    )
    if (output) console.info(output)
  } catch (error) {
    console.error(message(error))
    failure = message(error)
  }
  // Every write while Litestream is stopped, and a vacuumed file all the
  // more, leaves its local state describing another file. Without it,
  // Litestream reads its position from the bucket and uploads the database
  // whole as the next transaction, as after a rollback.
  if (litestream)
    rmSync(path.join(dataDir, '.midden.db-litestream'), {
      recursive: true,
      force: true,
    })
  console.info(`== starting ${current}`)
  const note = start(current, litestream ? { recreate: false } : undefined)
  return failure
    ? `failed: maintenance did not finish (${failure}); ${current} is running again${note}`
    : `maintained the database; ${current} is running again${note}`
}

if (import.meta.main) {
  const dir = deploymentDir()
  const run: Run = (command, args, env) =>
    execFileSync(command, args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim()
  // The deploy lock: no deployment starts the app meanwhile.
  const lock = path.join(dir, '.local', 'deploy.lock')
  mkdirSync(path.dirname(lock), { recursive: true })
  try {
    mkdirSync(lock)
  } catch {
    console.error(`a deployment holds ${lock}; remove it if none is running`)
    process.exit(1)
  }
  try {
    const result = maintain(dir, run, {
      vacuum: !process.argv.includes('--no-vacuum'),
      rebuildSearch: process.argv.includes('--rebuild-search'),
    })
    console.info(`result: ${result}`)
    if (result.startsWith('failed')) process.exitCode = 1
  } catch (error) {
    console.error(`result: failed: ${message(error)}`)
    process.exitCode = 1
  } finally {
    rmdirSync(lock)
  }
}
