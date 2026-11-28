#!/usr/bin/env node
// Deploy the newest published image to the checkout in MIDDEN_DIR (default
// ~/midden, /opt/midden for root on Linux), or with --check only report what
// would be deployed. A version that is not healthy, or fails the smoke test
// of its main endpoints, is rolled back. Uses Node built-ins (and curl) only: the deploy webhook runs
// this file as it is on origin/main.
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
import { performance } from 'node:perf_hooks'
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
// Litestream's first sync after it starts comes one monitor interval later
// (litestream.yml; this if it names none), plus time to check its place.
const MONITOR_INTERVAL = 10_000
const LITESTREAM_SETTLE = 5000
const INTERVAL = /^\s*monitor-interval:\s*(\d+)(ms|s|m)\s*$/m
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000 }
// The smoke test after a start: each request gets this many seconds, with a
// read-only token that expires on its own should revoking it fail.
const SMOKE_TIMEOUT = 15
const SMOKE_EXPIRES = '15m'
// What `midden token create --ro` prints on stdout, alone.
const SECRET = /^mdn_ro_[\w-]+$/

/**
 * The deployment checkout: MIDDEN_DIR, else /opt/midden for root on Linux
 * (a system service's home is no place for it), else ~/midden.
 */
export function deploymentDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  home: string = homedir(),
): string {
  if (env.MIDDEN_DIR) return path.resolve(env.MIDDEN_DIR)
  if (platform === 'linux' && uid === 0) return '/opt/midden'
  return path.join(home, 'midden')
}

/** Runs a command in the checkout and returns its trimmed stdout. */
export type Run = (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => string

/** An answer to a smoke test request; `error` when none came. */
export interface Response {
  status: number
  body: string
  error?: string
}

/** GET `url` with the bearer `token`; never throws. */
export type Get = (url: string, token: string) => Response

/**
 * curl, as for /healthz. The header goes in on stdin (`-H @-`): a secret in
 * the arguments would show in `ps` and in the message of a failed command.
 */
export function curlGet(
  url: string,
  token: string,
  timeout = SMOKE_TIMEOUT,
): Response {
  try {
    const output = execFileSync(
      'curl',
      [
        '-sS',
        '--max-time',
        String(timeout),
        '-H',
        '@-',
        '-w',
        '\n%{http_code}',
        url,
      ],
      {
        input: `Authorization: Bearer ${token}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: (timeout + 5) * 1000,
      },
    )
    const end = output.lastIndexOf('\n')
    return {
      status: Number(output.slice(end + 1)),
      body: output.slice(0, end),
    }
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: string }
    return {
      status: 0,
      body: '',
      // curl exits 28 on --max-time.
      error:
        status === 28
          ? 'timed out'
          : stderr?.trim().split('\n').at(-1) || message(error),
    }
  }
}

/** A smoke test check that did not pass: the deployment rolls back. */
class SmokeFailure extends Error {}

/**
 * The key `/v1/collections/graph?of=` takes for an account collection, as
 * the web writes it: platform, entity type and the platform's id, escaped.
 */
function accountKey(collection: {
  graph?: {
    root?: string
    entities?: { key?: string; type?: string; external_id?: string }[]
  }
}): string | undefined {
  const graph = collection.graph
  const root = graph?.entities?.find((entity) => entity.key === graph.root)
  if (!root?.type?.endsWith('.profile') || !root.external_id) return undefined
  return [root.type.split('.', 1)[0]!, root.type, root.external_id]
    .map((part) => encodeURIComponent(part))
    .join('/')
}

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
  /** The smoke test's requests; tests pass a fake. */
  get?: Get
  /** Milliseconds, for the smoke test's durations. */
  clock?: () => number
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

/**
 * Starting and stopping the services of the checkout in `dir`, in the
 * order deploy and maintenance (scripts/maintain.ts) share.
 */
export function services(
  dir: string,
  run: Run,
  sleep: (ms: number) => void = sleepSync,
) {
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

  /**
   * Start `revision` and wait until it reports healthy. With `litestream`,
   * Litestream comes first: its place in the WAL survives only if nothing
   * writes before its first sync after the restart. The app's first write
   * starts the WAL over; overwriting the frame Litestream synced last makes
   * it lose its place and upload the whole database again. Litestream
   * failing to start does not hold up the app; the note says so.
   */
  function start(revision: string, litestream?: { recreate: boolean }): string {
    run('git', ['checkout', '--quiet', '--detach', revision])
    let note = ''
    if (litestream) {
      note = startLitestream(litestream.recreate)
      if (!note) sleep(litestreamSettle())
    }
    // The web process first: it applies the migrations, which the worker
    // waits for.
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
    return note
  }

  /** How long Litestream takes to sync once after it starts. */
  function litestreamSettle(): number {
    let interval = MONITOR_INTERVAL
    try {
      const match = INTERVAL.exec(
        readFileSync(path.join(dir, 'litestream.yml'), 'utf8'),
      )
      if (match) interval = Number(match[1]) * UNIT[match[2]!]!
    } catch {}
    return interval + LITESTREAM_SETTLE
  }

  function healthz(): string {
    return `${base()}/healthz`
  }

  /** Where the started version answers on this host. */
  function base(): string {
    return `http://127.0.0.1:${settings().port}`
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

  return {
    imageRevision,
    runningRevision,
    settings,
    base,
    start,
    litestreamConfigChanged,
    hasWorker,
    stopWorker,
    stopAll,
  }
}

/** Deploy, or with `check` only report; returns the result line. */
export function deploy(
  dir: string,
  run: Run,
  {
    check = false,
    sleep = sleepSync,
    get = curlGet,
    clock = () => performance.now(),
  }: DeployOptions = {},
): string {
  const {
    imageRevision,
    runningRevision,
    settings,
    base,
    start,
    litestreamConfigChanged,
    stopWorker,
    stopAll,
  } = services(dir, run, sleep)

  /**
   * With everything stopped, a copy of the database and its WAL, kept with
   * the newest `keep` copies. Cloned (copy-on-write: APFS, Btrfs, XFS)
   * where the file system can, so even a large database copies at once;
   * elsewhere (ext4) a full copy. No checkpoint: resetting the WAL would
   * lose Litestream its place (see start); the two files together are
   * consistent.
   */
  function snapshot(dataDir: string, keep: number): Backup {
    const database = path.join(dataDir, 'midden.db')
    const walSize = () =>
      existsSync(`${database}-wal`) ? statSync(`${database}-wal`).size : 0
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

  /** `midden` in the running web container. */
  function cli(...args: string[]): string {
    return run('docker', ['compose', 'exec', '-T', 'midden', 'midden', ...args])
  }

  /**
   * Read the main endpoints of the started version with a read-only token
   * made for it and revoked afterwards, whatever happens; returns the
   * summary for the result line. Throws a SmokeFailure naming what failed.
   */
  function smokeTest(revision: string): string {
    step('smoke test')
    // Unique, so revoking by label never meets an older token.
    const label = `deploy-smoke-${revision.slice(0, 12)}-${Date.now().toString(36)}`
    let token: string
    try {
      token = cli(
        'token',
        'create',
        '--ro',
        '--label',
        label,
        '--expires',
        SMOKE_EXPIRES,
      )
      // Never the output in the message: it may be the secret.
      if (!SECRET.test(token))
        throw new Error('token create printed no read-only token')
    } catch (error) {
      revoke(label)
      throw new SmokeFailure(
        `smoke failed: could not make a token: ${message(error)}`,
      )
    }
    try {
      return smokeChecks(token)
    } finally {
      revoke(label)
    }
  }

  /** Revoke the smoke test token; a failure is reported, not thrown. */
  function revoke(label: string) {
    try {
      cli('token', 'revoke', label)
    } catch (error) {
      console.error(
        `could not revoke the smoke test token ${label} (it expires in ${SMOKE_EXPIRES}): ${message(error)}`,
      )
    }
  }

  /**
   * The checks, in order; the ones that need a collection or an account
   * are skipped when the library has none (a new or empty install).
   */
  function smokeChecks(token: string): string {
    const origin = base()
    const results: { name: string; seconds: number; problem?: string }[] = []
    let skipped = 0
    /** The JSON of a 2xx answer; undefined when the check failed. */
    const check = (name: string, target: string): any => {
      const started = clock()
      let response: Response
      try {
        response = get(origin + target, token)
      } catch (error) {
        response = { status: 0, body: '', error: message(error) }
      }
      const seconds = (clock() - started) / 1000
      let problem =
        response.error ??
        (response.status >= 200 && response.status < 300
          ? undefined
          : String(response.status))
      let json: unknown
      if (!problem)
        try {
          json = JSON.parse(response.body)
        } catch {
          problem = `${response.status}, not JSON`
        }
      const endpoint = `GET ${target.split('?', 1)[0]}`
      console.info(
        `${problem ? 'FAIL' : 'ok'} ${endpoint} ${problem ?? response.status} ${seconds.toFixed(2)}s`,
      )
      results.push({
        name,
        seconds,
        ...(problem ? { problem: `${endpoint} ${problem}` } : {}),
      })
      return problem ? undefined : json
    }
    const skip = (what: string) => {
      skipped++
      console.info(`skipped ${what}`)
    }

    check('session', '/v1/session')
    const list = check('collections', '/v1/collections?limit=20')
    check('count', '/v1/collections/count')
    check('stats', '/v1/library/stats')
    check('folders', '/v1/folders')
    check('captures', '/v1/captures')
    const first = list?.items?.[0]?.id
    if (typeof first === 'string')
      check('detail', `/v1/collections/${encodeURIComponent(first)}`)
    else if (list) skip('a collection: the library has none')
    const profiles = check(
      'profiles',
      `/v1/collections?q=${encodeURIComponent('type:profile')}&limit=1`,
    )
    let profile = profiles?.items?.[0]
    // The list carries the graph; the collection itself, should it not.
    if (profile && !accountKey(profile) && typeof profile.id === 'string')
      profile = check(
        'profile',
        `/v1/collections/${encodeURIComponent(profile.id)}`,
      )
    const key = profile && accountKey(profile)
    if (key)
      check(
        'graph',
        `/v1/collections/graph?of=${encodeURIComponent(key)}&kinds=following,followers&limit=50`,
      )
    else if (profiles) skip('the relation graph: the library has no account')
    check('whoami', '/agent/v1/whoami')
    check('posts', '/agent/v1/posts?size=5')
    check('aggregate', '/agent/v1/aggregate?by=month')

    const failed = results.filter((result) => result.problem)
    const passed = results.length - failed.length
    if (failed.length)
      throw new SmokeFailure(
        `smoke failed ${passed}/${results.length}: ${failed.map((result) => result.problem).join(', ')}`,
      )
    const slowest = results.reduce((a, b) => (b.seconds > a.seconds ? b : a))
    return `smoke ${passed}/${results.length}${skipped ? `, ${skipped} skipped` : ''}, slowest ${slowest.name} ${slowest.seconds.toFixed(1)}s`
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
      backup = snapshot(dataDir, litestream ? 1 : 2)
      console.info(backup.database)
    } catch (error) {
      console.error(message(error))
      step(`starting ${current} again`)
      const note = start(current, litestream ? { recreate: false } : undefined)
      throw new Error(
        `could not back up the database; ${current} is running again${note}`,
        { cause: error },
      )
    }
  }
  let note: string
  let smoked: string
  try {
    step(`starting ${revision}`)
    note = start(
      revision,
      litestream
        ? {
            recreate: !!current && litestreamConfigChanged(current, revision),
          }
        : undefined,
    )
    smoked = smokeTest(revision)
  } catch (error) {
    console.error(message(error))
    const smoke = error instanceof SmokeFailure
    if (!current)
      throw new Error(
        smoke
          ? `${revision} ${error.message}`
          : `${revision} did not become healthy`,
        { cause: error },
      )
    // Migrations may have run: put back the database the old version knew.
    // What the new version wrote since it started goes with it.
    step(`rolling back to ${current}`)
    restore(dataDir, backup!, litestream)
    const back = start(
      current,
      litestream
        ? { recreate: litestreamConfigChanged(revision, current) }
        : undefined,
    )
    return `rolled back ${revision}: ${smoke ? error.message : 'unhealthy'}; running ${current} with the database from ${backup!.database}${back}`
  }
  pruneImages([revision, current])
  return `deployed ${revision} (was ${current || 'nothing'}); ${smoked}${note}`
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  const dir = deploymentDir()
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
