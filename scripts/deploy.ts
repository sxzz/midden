#!/usr/bin/env node
// Deploy the newest published image to the checkout in MIDDEN_DIR (default
// ~/midden), or with --check only report what would be deployed. Uses Node
// built-ins only: the deploy webhook runs this file as it is on origin/main.
//
//   node scripts/deploy.ts [--check]
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseEnv } from 'node:util'

const IMAGE = 'ghcr.io/sxzz/midden'
const REVISION = /^[\da-f]{40}$/
// Database snapshots kept: this deployment's and the one before.
const KEEP_SNAPSHOTS = 2

const check = process.argv.includes('--check')
const dir = path.resolve(
  process.env.MIDDEN_DIR || path.join(homedir(), 'midden'),
)
const lock = path.join(dir, '.local', 'deploy.lock')

function run(command: string, args: string[], env?: Record<string, string>) {
  return execFileSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

function step(message: string) {
  console.info(`== ${message}`)
}

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
  return {
    dataDir: path.resolve(dir, env.DATA_PATH || 'data'),
    port: env.PORT || '8080',
  }
}

/** Start `revision` and wait until it reports healthy. */
function start(revision: string) {
  run('git', ['checkout', '--quiet', '--detach', revision])
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
    ],
    { MIDDEN_IMAGE: `${IMAGE}:sha-${revision}` },
  )
  const { port } = settings()
  const health = run('curl', [
    '-fsS',
    '--max-time',
    '5',
    `http://127.0.0.1:${port}/healthz`,
  ])
  if (health !== 'ok') throw new Error(`unexpected health response: ${health}`)
}

/** A consistent copy of the database, taken by the running server. */
function snapshot(dataDir: string): string {
  const inside = run('docker', [
    'compose',
    'exec',
    '-T',
    'midden',
    'node',
    'server/src/cli.ts',
    'backup',
    '/data/backups/deploy',
  ])
  const file = path.join(dataDir, 'backups', 'deploy', path.basename(inside))
  const older = readdirSync(path.dirname(file))
    .filter((name) => name.endsWith('.db'))
    .toSorted()
    .slice(0, -KEEP_SNAPSHOTS)
  for (const name of older)
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(path.join(path.dirname(file), name + suffix), { force: true })
  return file
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
    console.error(
      `could not remove old images: ${error instanceof Error ? error.message : error}`,
    )
  }
}

function restore(dataDir: string, file: string) {
  run('docker', ['compose', 'stop', 'midden'])
  const database = path.join(dataDir, 'midden.db')
  for (const suffix of ['-wal', '-shm'])
    rmSync(database + suffix, { force: true })
  copyFileSync(file, database)
}

function deploy(): string {
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

  const { dataDir } = settings()
  let backup = ''
  if (current) {
    // Rolling back needs the running version's image under its own tag.
    run('docker', ['pull', '--quiet', `${IMAGE}:sha-${current}`])
    step('backing up the database')
    backup = snapshot(dataDir)
    console.info(backup)
  }
  try {
    step(`starting ${revision}`)
    start(revision)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    if (!current)
      throw new Error(`${revision} did not become healthy`, { cause: error })
    // Migrations may have run: put back the database the old version knew.
    step(`rolling back to ${current}`)
    restore(dataDir, backup)
    start(current)
    return `rolled back ${revision}: unhealthy; running ${current} with the database from ${backup}`
  }
  pruneImages([revision, current])
  return `deployed ${revision} (was ${current || 'nothing'})`
}

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
  const result = deploy()
  console.info(`result: ${result}`)
  if (result.startsWith('rolled back')) process.exitCode = 1
} catch (error) {
  console.error(
    `result: failed: ${error instanceof Error ? error.message : error}`,
  )
  process.exitCode = 1
} finally {
  rmdirSync(lock)
}
