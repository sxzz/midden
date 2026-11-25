#!/usr/bin/env node
// Deploy the newest published image to the checkout in MIDDEN_DIR (default
// ~/midden), or with --check only report what would be deployed. Uses Node
// built-ins only: the deploy webhook runs this file as it is on origin/main.
//
//   node scripts/deploy.ts [--check]

/* eslint-disable unicorn/no-exports-in-scripts -- for deploy.test.ts; the
   webhook runs this file alone, so the code cannot move to a module. */
import { execFileSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseEnv } from 'node:util'

const IMAGE = 'ghcr.io/sxzz/midden'
const REVISION = /^[\da-f]{40}$/
// The compose profile, and service, of the Litestream sidecar.
const LITESTREAM = 'litestream'
// The job worker, beside the web process `midden` (versions before the
// split have none).
const WORKER = 'midden-worker'
// A started version gets this many tries at /healthz, this far apart, before
// it counts as unhealthy: one slow answer must not roll a deployment back.
const HEALTH_ATTEMPTS = 5
const HEALTH_RETRY_DELAY = 6000
// Run with node in a one-off container while the app and Litestream are
// stopped: moves the WAL into the database file, so the copy is one file.
const CHECKPOINT = `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.env.DATA_DIR + '/midden.db', { timeout: 60000 })
const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
db.close()
console.log(JSON.stringify(result))
if (result.busy) process.exit(1)`

/** Runs a command in the checkout and returns its trimmed stdout. */
export type Run = (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => string

function step(message: string) {
  console.info(`== ${message}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface DeployOptions {
  /** Only report what would be deployed. */
  check?: boolean
  /** Blocks between health checks; tests pass a recorder. */
  sleep?: (ms: number) => void
}

/** A pre-deploy copy of the database, with its WAL if one was left. */
interface Backup {
  database: string
  wal?: string
}

/** A copy-on-write clone where the file system allows, else a copy. */
function clone(from: string, to: string) {
  copyFileSync(from, to, constants.COPYFILE_FICLONE)
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Deploy, or with `check` only report; returns the result line. */
export function deploy(
  dir: string,
  run: Run,
  { check = false, sleep = sleepSync }: DeployOptions = {},
): string {
  function imageRevision(image: string): string {
    return run('docker', [
      'image',
      'inspect',
      image,
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ])
  }

  /** The revision of the running container, or '' when none runs. */
  function runningRevision(): string {
    const id = run('docker', ['compose', 'ps', '-q', 'midden'])
    if (!id) return ''
    const image = run('docker', ['inspect', id, '--format', '{{.Image}}'])
    const revision = imageRevision(image)
    return REVISION.test(revision) ? revision : ''
  }

  function settings() {
    let env: Record<string, string | undefined> = {}
    try {
      env = parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'))
    } catch {}
    // Compose takes COMPOSE_PROFILES from the environment before .env.
    const profiles = process.env.COMPOSE_PROFILES ?? env.COMPOSE_PROFILES ?? ''
    return {
      dataDir: path.resolve(dir, env.DATA_PATH || 'data'),
      port: env.PORT || '8080',
      litestream: profiles
        .split(',')
        .map((profile) => profile.trim())
        .includes(LITESTREAM),
    }
  }

  /** Start `revision` and wait until it reports healthy. */
  function start(revision: string) {
    run('git', ['checkout', '--quiet', '--detach', revision])
    // The app alone: the sidecar must not hold up or fail a deployment. The
    // web process first: it applies the migrations, which the worker waits
    // for.
    up('midden', revision)
    for (let attempt = 1; ; attempt++) {
      try {
        const health = run('curl', ['-fsS', '--max-time', '5', healthz()])
        if (health !== 'ok')
          throw new Error(`unexpected health response: ${health}`)
        break
      } catch (error) {
        if (attempt >= HEALTH_ATTEMPTS) throw error
        console.error(
          `health check ${attempt}/${HEALTH_ATTEMPTS} failed: ${message(error)}; trying again in ${HEALTH_RETRY_DELAY / 1000} s`,
        )
        sleep(HEALTH_RETRY_DELAY)
      }
    }
    if (hasWorker()) up(WORKER, revision)
  }

  function healthz(): string {
    return `http://127.0.0.1:${settings().port}/healthz`
  }

  /**
   * Start Litestream, or apply a changed definition; `recreate` also picks
   * up a changed litestream.yml, which compose does not see. A failure is
   * reported in the result instead of failing the deployment.
   */
  function startLitestream(recreate: boolean): string {
    step('starting litestream')
    try {
      run('docker', [
        'compose',
        'up',
        '-d',
        ...(recreate ? ['--force-recreate'] : []),
        LITESTREAM,
      ])
      return ''
    } catch (error) {
      console.error(`could not start litestream: ${message(error)}`)
      return '; litestream did not start'
    }
  }

  function litestreamConfigChanged(from: string, to: string): boolean {
    try {
      run('git', ['diff', '--quiet', from, to, '--', 'litestream.yml'])
      return false
    } catch {
      return true
    }
  }

  /** Whether the checked-out compose.yaml defines the worker. */
  function hasWorker(): boolean {
    return run('docker', ['compose', 'config', '--services'])
      .split('\n')
      .includes(WORKER)
  }

  /**
   * Stop the worker of the checked-out version, if it has one. Running
   * jobs go back to the queue and run again under the next version.
   */
  function stopWorker() {
    if (hasWorker()) run('docker', ['compose', 'stop', WORKER])
  }

  /** Start a service of `revision` and wait for its health check. */
  function up(service: string, revision: string) {
    run(
      'docker',
      [
        'compose',
        'up',
        '-d',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '180',
        service,
      ],
      { MIDDEN_IMAGE: `${IMAGE}:sha-${revision}` },
    )
  }

  /**
   * Stop the worker, the web process, then Litestream, which copies what
   * they wrote last.
   */
  function stopAll(litestream: boolean) {
    stopWorker()
    run('docker', ['compose', 'stop', 'midden'])
    if (litestream) run('docker', ['compose', 'stop', LITESTREAM])
  }

  /**
   * With both stopped, a copy of the database as `revision` left it, kept
   * with the newest `keep` copies. Cloned (APFS, copy-on-write) where the
   * file system can, so even a large database copies at once; no reader
   * holds the WAL back meanwhile, as an online backup did.
   */
  function snapshot(dataDir: string, revision: string, keep: number): Backup {
    const database = path.join(dataDir, 'midden.db')
    const walSize = () =>
      existsSync(`${database}-wal`) ? statSync(`${database}-wal`).size : 0
    if (walSize() > 0)
      try {
        const result = run(
          'docker',
          [
            'compose',
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--entrypoint',
            'node',
            'midden',
            '-e',
            CHECKPOINT,
          ],
          { MIDDEN_IMAGE: `${IMAGE}:sha-${revision}` },
        )
        console.info(`checkpoint: ${result}`)
      } catch (error) {
        // The copy then takes the WAL along; together they are consistent.
        console.error(`checkpoint failed: ${message(error)}`)
      }
    const folder = path.join(dataDir, 'backups', 'deploy')
    mkdirSync(folder, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const backup: Backup = { database: path.join(folder, `midden-${stamp}.db`) }
    clone(database, backup.database)
    if (walSize() > 0) {
      backup.wal = `${backup.database}-wal`
      clone(`${database}-wal`, backup.wal)
    }
    const older = readdirSync(folder)
      .filter((name) => name.endsWith('.db'))
      .toSorted()
      .slice(0, -keep)
    for (const name of older)
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(path.join(folder, name + suffix), { force: true })
    return backup
  }

  /**
   * Remove the service's images other than the running revision and the one
   * a rollback would return to. A failure here does not fail the deployment.
   */
  function pruneImages(keep: string[]) {
    try {
      const tags = run('docker', [
        'image',
        'ls',
        IMAGE,
        '--format',
        '{{.Tag}}',
      ]).split('\n')
      const stale = tags.filter(
        (tag) =>
          tag.startsWith('sha-') && !keep.includes(tag.slice('sha-'.length)),
      )
      if (stale.length)
        run('docker', ['image', 'rm', ...stale.map((tag) => `${IMAGE}:${tag}`)])
      // Earlier `latest` pulls left these untagged.
      run('docker', [
        'image',
        'prune',
        '--force',
        '--filter',
        `label=org.opencontainers.image.source=https://github.com/sxzz/midden`,
      ])
      if (stale.length) console.info(`removed images ${stale.join(', ')}`)
    } catch (error) {
      console.error(`could not remove old images: ${message(error)}`)
    }
  }

  function restore(dataDir: string, backup: Backup, litestream: boolean) {
    // Litestream holds the database and its WAL open: replacing them under
    // it breaks the file or its copy in R2. Stop it before the app.
    if (litestream) run('docker', ['compose', 'stop', LITESTREAM])
    stopWorker()
    run('docker', ['compose', 'stop', 'midden'])
    const database = path.join(dataDir, 'midden.db')
    for (const suffix of ['-wal', '-shm'])
      rmSync(database + suffix, { force: true })
    clone(backup.database, database)
    if (backup.wal) clone(backup.wal, `${database}-wal`)
    // Its local state describes the replaced file. Without it Litestream
    // reads its position from the bucket and uploads this file whole as the
    // next transaction, so the history before the rollback stays restorable.
    if (litestream)
      rmSync(path.join(dataDir, '.midden.db-litestream'), {
        recursive: true,
        force: true,
      })
  }

  if (run('git', ['status', '--porcelain', '--untracked-files=normal']))
    throw new Error(`${dir} has local changes; commit or move them first`)

  step('checking the published image')
  run('docker', ['pull', '--quiet', `${IMAGE}:latest`])
  const revision = imageRevision(`${IMAGE}:latest`)
  if (!REVISION.test(revision))
    throw new Error('the latest image has no source revision')
  run('git', ['fetch', '--quiet', 'origin', 'main'])
  try {
    run('git', ['merge-base', '--is-ancestor', revision, 'origin/main'])
  } catch (error) {
    throw new Error(`published revision ${revision} is not on origin/main`, {
      cause: error,
    })
  }
  const current = runningRevision()
  if (check)
    return `ready ${revision} (running ${current || 'nothing'}); nothing changed`
  if (revision === current) return `already ${revision}`

  run('docker', ['pull', '--quiet', `${IMAGE}:sha-${revision}`])
  if (imageRevision(`${IMAGE}:sha-${revision}`) !== revision)
    throw new Error(`${IMAGE}:sha-${revision} has another revision`)

  const { dataDir, litestream } = settings()
  let backup: Backup | undefined
  if (current) {
    // Rolling back needs the running version's image under its own tag.
    run('docker', ['pull', '--quiet', `${IMAGE}:sha-${current}`])
    // The app restarts anyway: stopped, the database copies at once and
    // nothing has to wait for the copy.
    step(`stopping ${current}`)
    stopAll(litestream)
    try {
      step('backing up the database')
      // This deployment's copy is what a rollback restores. The one before
      // only guarded against a bad version found later; Litestream's
      // history covers that, so it is kept only without Litestream.
      backup = snapshot(dataDir, current, litestream ? 1 : 2)
      console.info(backup.database)
    } catch (error) {
      console.error(message(error))
      step(`starting ${current} again`)
      let note = ''
      try {
        start(current)
      } finally {
        if (litestream) note = startLitestream(false)
      }
      throw new Error(
        `could not back up the database; ${current} is running again${note}`,
        { cause: error },
      )
    }
  }
  try {
    step(`starting ${revision}`)
    start(revision)
  } catch (error) {
    console.error(message(error))
    if (!current)
      throw new Error(`${revision} did not become healthy`, { cause: error })
    // Migrations may have run: put back the database the old version knew.
    step(`rolling back to ${current}`)
    restore(dataDir, backup!, litestream)
    let note = ''
    try {
      start(current)
    } finally {
      if (litestream) note = startLitestream(false)
    }
    return `rolled back ${revision}: unhealthy; running ${current} with the database from ${backup!.database}${note}`
  }
  pruneImages([revision, current])
  const note = litestream
    ? startLitestream(!!current && litestreamConfigChanged(current, revision))
    : ''
  return `deployed ${revision} (was ${current || 'nothing'})${note}`
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  const dir = path.resolve(
    process.env.MIDDEN_DIR || path.join(homedir(), 'midden'),
  )
  const run: Run = (command, args, env) =>
    execFileSync(command, args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim()
  const lock = path.join(dir, '.local', 'deploy.lock')

  mkdirSync(path.dirname(lock), { recursive: true })
  try {
    mkdirSync(lock)
  } catch {
    console.error(
      `another deployment holds ${lock}; remove it if none is running`,
    )
    process.exit(1)
  }
  try {
    // The last line is the result, read by the deploy webhook.
    const result = deploy(dir, run, { check })
    console.info(`result: ${result}`)
    if (result.startsWith('rolled back')) process.exitCode = 1
  } catch (error) {
    console.error(`result: failed: ${message(error)}`)
    process.exitCode = 1
  } finally {
    rmdirSync(lock)
  }
}
