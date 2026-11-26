import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { deploy, type Run } from './deploy.ts'

const IMAGE = 'ghcr.io/sxzz/midden'
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const HEALTH = 'curl -fsS --max-time 5 http://127.0.0.1:8080/healthz'
const SERVICES = 'docker compose config --services'
const UP_LITESTREAM = 'docker compose up -d litestream'
// The default monitor interval (10 s) and the margin after it.
const SETTLE = 'sleep 15000'
const upService = (service: string, revision: string) =>
  `docker compose up -d --pull never --wait --wait-timeout 180 ${service} [${IMAGE}:sha-${revision}]`
const up = (revision: string) => upService('midden', revision)
const upWorker = (revision: string) => upService('midden-worker', revision)

interface Fake {
  /** Commands, and the waits between them as `sleep <ms>`. */
  calls: string[]
  sleep: (ms: number) => void
  /** State of the data directory seen by named commands. */
  seen: Record<string, { database: string; wal: boolean; state: boolean }>
}

/**
 * A deployment host with OLD running and NEW published: commands are
 * recorded, answered from these canned replies, and `fail` makes a command
 * throw. Starting NEW migrates the database first, failing or not.
 * `workers` are the revisions whose compose.yaml has the worker.
 */
function host(
  dir: string,
  fail: (call: string) => boolean,
  workers: string[] = [],
): Fake & { run: Run } {
  const data = path.join(dir, 'data')
  const database = path.join(data, 'midden.db')
  const fake: Fake = {
    calls: [],
    sleep: (ms) => fake.calls.push(`sleep ${ms}`),
    seen: {},
  }
  // The checkout is at the running version until a deployment moves it.
  let checkedOut = OLD
  const look = (name: string) =>
    (fake.seen[name] = {
      database: readFileSync(database, 'utf8'),
      wal: existsSync(`${database}-wal`),
      state: existsSync(path.join(data, '.midden.db-litestream')),
    })
  const run: Run = (command, args, env) => {
    const call = [command, ...args].join(' ')
    fake.calls.push(env?.MIDDEN_IMAGE ? `${call} [${env.MIDDEN_IMAGE}]` : call)
    if (fake.calls.at(-1) === up(NEW)) {
      writeFileSync(database, 'migrated by the new version')
      writeFileSync(`${database}-wal`, 'new wal')
    }
    if (fail(fake.calls.at(-1)!)) throw new Error(`${call} failed`)
    if (call.startsWith('docker image inspect')) {
      const image = args[2]
      return image === `${IMAGE}:latest` || image.endsWith(NEW) ? NEW : OLD
    }
    if (call === 'docker compose ps -q midden') return 'container'
    if (call.startsWith('git checkout')) checkedOut = args.at(-1)!
    if (call === SERVICES)
      return [
        'midden',
        ...(workers.includes(checkedOut) ? ['midden-worker'] : []),
        'litestream',
      ].join('\n')
    if (call.startsWith('docker inspect container')) return 'sha256:old'
    if (call === 'docker compose stop midden') look('stop midden')
    if (call === 'docker compose stop midden-worker') look('stop worker')
    if (call === 'docker compose stop litestream') look('stop litestream')
    if (call.startsWith('docker compose up -d litestream'))
      look('up litestream')
    if (call.startsWith('docker compose up -d --force-recreate litestream'))
      look('up litestream')
    if (command === 'curl') return 'ok'
    return ''
  }
  return { ...fake, run }
}

/** The starts, stops, checkouts, waits and health checks, in order. */
function steps(fake: Fake) {
  return fake.calls.filter(
    (call) =>
      call.startsWith('docker compose up') ||
      call.startsWith('docker compose stop') ||
      call.startsWith('git checkout') ||
      call.startsWith('sleep ') ||
      call === HEALTH,
  )
}

describe('deploy', () => {
  let dir: string
  let data: string
  let profiles: string | undefined

  beforeEach(() => {
    mock.method(console, 'info', () => {})
    mock.method(console, 'error', () => {})
    profiles = process.env.COMPOSE_PROFILES
    delete process.env.COMPOSE_PROFILES
    dir = mkdtempSync(path.join(tmpdir(), 'midden-deploy-'))
    data = path.join(dir, 'data')
    mkdirSync(path.join(data, 'backups', 'deploy'), { recursive: true })
    mkdirSync(path.join(data, '.midden.db-litestream', 'ltx', '0'), {
      recursive: true,
    })
    writeFileSync(path.join(data, 'midden.db'), 'as the old version left it')
    writeFileSync(path.join(data, 'midden.db-wal'), 'wal')
    writeFileSync(path.join(data, 'midden.db-shm'), 'shm')
    for (const name of ['midden-2026-11-01.db', 'midden-2026-11-02.db'])
      writeFileSync(path.join(data, 'backups', 'deploy', name), 'older')
  })
  afterEach(() => {
    mock.restoreAll()
    if (profiles === undefined) delete process.env.COMPOSE_PROFILES
    else process.env.COMPOSE_PROFILES = profiles
    rmSync(dir, { recursive: true, force: true })
  })

  const env = (text: string) => writeFileSync(path.join(dir, '.env'), text)
  const backupFiles = () =>
    readdirSync(path.join(data, 'backups', 'deploy')).toSorted()
  const snapshots = () => backupFiles().filter((name) => name.endsWith('.db'))
  const unhealthy = (call: string) =>
    call.startsWith('docker compose up -d --pull never') &&
    call.endsWith(`[${IMAGE}:sha-${NEW}]`)

  test('without Litestream a rollback restores the copy taken while stopped', () => {
    env('SECRET_KEY=x\n')
    const fake = host(dir, unhealthy)
    const result = deploy(dir, fake.run, fake)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    assert.deepEqual(fake.calls, [
      'git status --porcelain --untracked-files=normal',
      `docker pull --quiet ${IMAGE}:latest`,
      `docker image inspect ${IMAGE}:latest --format {{index .Config.Labels "org.opencontainers.image.revision"}}`,
      'git fetch --quiet origin main',
      `git merge-base --is-ancestor ${NEW} origin/main`,
      'docker compose ps -q midden',
      'docker inspect container --format {{.Image}}',
      'docker image inspect sha256:old --format {{index .Config.Labels "org.opencontainers.image.revision"}}',
      `docker pull --quiet ${IMAGE}:sha-${NEW}`,
      `docker image inspect ${IMAGE}:sha-${NEW} --format {{index .Config.Labels "org.opencontainers.image.revision"}}`,
      `docker pull --quiet ${IMAGE}:sha-${OLD}`,
      SERVICES,
      'docker compose stop midden',
      `git checkout --quiet --detach ${NEW}`,
      up(NEW),
      SERVICES,
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      up(OLD),
      HEALTH,
      SERVICES,
    ])
    // The database and its WAL as the old version left them: no checkpoint
    // ran on them.
    assert.equal(
      readFileSync(path.join(data, 'midden.db'), 'utf8'),
      'as the old version left it',
    )
    assert.equal(readFileSync(path.join(data, 'midden.db-wal'), 'utf8'), 'wal')
    assert.ok(!existsSync(path.join(data, 'midden.db-shm')))
    // The previous deployment's copy stays as well.
    const copy = snapshots().at(-1)!
    assert.deepEqual(backupFiles(), [
      'midden-2026-11-02.db',
      copy,
      `${copy}-wal`,
    ])
  })

  test('a rollback stops Litestream first and starts it before the old version', () => {
    env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
    const fake = host(dir, unhealthy)
    const result = deploy(dir, fake.run, fake)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    assert.deepEqual(steps(fake), [
      // The app first: Litestream copies what it wrote last.
      'docker compose stop midden',
      'docker compose stop litestream',
      `git checkout --quiet --detach ${NEW}`,
      UP_LITESTREAM,
      SETTLE,
      up(NEW),
      'docker compose stop litestream',
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      UP_LITESTREAM,
      SETTLE,
      up(OLD),
      HEALTH,
    ])
    // The files are put back only once both have stopped.
    assert.deepEqual(fake.seen['stop litestream'], {
      database: 'migrated by the new version',
      wal: true,
      state: true,
    })
    // Litestream comes back to the restored files without its old state,
    // so it starts over from the bucket with a full copy.
    assert.deepEqual(fake.seen['up litestream'], {
      database: 'as the old version left it',
      wal: true,
      state: false,
    })
    // Only this deployment's copy is kept.
    assert.equal(snapshots().length, 1)
  })

  test('Litestream runs again even when the old version fails too', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const fake = host(dir, (call) =>
      call.startsWith('docker compose up -d --pull never'),
    )
    assert.throws(() => deploy(dir, fake.run, fake), /docker compose up/)
    assert.deepEqual(fake.calls.slice(-3), [UP_LITESTREAM, SETTLE, up(OLD)])
  })

  test('Litestream starts before the app, a monitor interval ahead of it', () => {
    env('COMPOSE_PROFILES=litestream\n')
    writeFileSync(
      path.join(dir, 'litestream.yml'),
      'dbs:\n  - path: /data/midden.db\n    monitor-interval: 3s\n',
    )
    const fake = host(dir, () => false)
    const result = deploy(dir, fake.run, fake)

    assert.equal(result, `deployed ${NEW} (was ${OLD})`)
    assert.deepEqual(steps(fake), [
      'docker compose stop midden',
      'docker compose stop litestream',
      `git checkout --quiet --detach ${NEW}`,
      UP_LITESTREAM,
      'sleep 8000',
      up(NEW),
      HEALTH,
    ])
    // It finds the database, the WAL and its own state as it left them.
    assert.deepEqual(fake.seen['up litestream'], {
      database: 'as the old version left it',
      wal: true,
      state: true,
    })
    assert.equal(snapshots().length, 1)
  })

  test('a changed litestream.yml recreates the sidecar', () => {
    process.env.COMPOSE_PROFILES = 'litestream'
    const fake = host(dir, (call) => call.startsWith('git diff'))
    deploy(dir, fake.run, fake)
    const recreate = fake.calls.indexOf(
      'docker compose up -d --force-recreate litestream',
    )
    assert.ok(recreate !== -1 && recreate < fake.calls.indexOf(up(NEW)))
  })

  test('Litestream failing to start does not fail the deployment', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const fake = host(dir, (call) => call === UP_LITESTREAM)
    assert.equal(
      deploy(dir, fake.run, fake),
      `deployed ${NEW} (was ${OLD}); litestream did not start`,
    )
    assert.ok(!fake.calls.includes(SETTLE))
  })

  test('a slow health check is tried again before rolling back', () => {
    env('SECRET_KEY=x\n')
    let checks = 0
    const fake = host(dir, (call) => call === HEALTH && ++checks <= 3)
    const waits: number[] = []
    const result = deploy(dir, fake.run, { sleep: (ms) => waits.push(ms) })

    assert.equal(result, `deployed ${NEW} (was ${OLD})`)
    assert.equal(fake.calls.filter((call) => call === HEALTH).length, 4)
    assert.deepEqual(waits, [6000, 6000, 6000])
    // Only for the copy.
    assert.equal(
      fake.calls.filter((call) => call === 'docker compose stop midden').length,
      1,
    )
  })

  test('the new version is rolled back after five failed health checks', () => {
    env('SECRET_KEY=x\n')
    let checks = 0
    const fake = host(dir, (call) => call === HEALTH && ++checks <= 5)
    const waits: number[] = []
    const result = deploy(dir, fake.run, { sleep: (ms) => waits.push(ms) })

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    const stop = fake.calls.lastIndexOf('docker compose stop midden')
    assert.equal(
      fake.calls.slice(0, stop).filter((call) => call === HEALTH).length,
      5,
    )
    assert.equal(waits.length, 4)
    // The old version answers at once.
    assert.equal(fake.calls.at(-2), HEALTH)
  })

  test('without a WAL the copy is the database alone', () => {
    env('SECRET_KEY=x\n')
    rmSync(path.join(data, 'midden.db-wal'))
    const fake = host(dir, () => false)
    assert.equal(deploy(dir, fake.run, fake), `deployed ${NEW} (was ${OLD})`)
    assert.ok(backupFiles().every((name) => !name.endsWith('-wal')))
  })

  test('the running version starts again when the copy fails', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const backups = path.join(data, 'backups')
    rmSync(backups, { recursive: true })
    writeFileSync(backups, 'not a directory')
    const fake = host(dir, () => false)

    assert.throws(
      () => deploy(dir, fake.run, fake),
      new RegExp(`could not back up the database; ${OLD} is running again`),
    )
    assert.deepEqual(fake.calls.slice(-6), [
      `git checkout --quiet --detach ${OLD}`,
      UP_LITESTREAM,
      SETTLE,
      up(OLD),
      HEALTH,
      SERVICES,
    ])
    assert.ok(!fake.calls.includes(up(NEW)))
  })

  test('the worker stops first and starts after the web process', () => {
    env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
    const fake = host(dir, () => false, [OLD, NEW])
    const result = deploy(dir, fake.run, fake)

    assert.equal(result, `deployed ${NEW} (was ${OLD})`)
    assert.deepEqual(steps(fake), [
      'docker compose stop midden-worker',
      'docker compose stop midden',
      'docker compose stop litestream',
      `git checkout --quiet --detach ${NEW}`,
      UP_LITESTREAM,
      SETTLE,
      up(NEW),
      HEALTH,
      upWorker(NEW),
    ])
  })

  test('the first version with a worker starts it; the old one had none to stop', () => {
    env('SECRET_KEY=x\n')
    const fake = host(dir, () => false, [NEW])
    deploy(dir, fake.run, fake)

    assert.ok(!fake.calls.includes('docker compose stop midden-worker'))
    assert.ok(fake.calls.includes(upWorker(NEW)))
  })

  test('a worker that does not become healthy rolls back both', () => {
    env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
    const fake = host(dir, (call) => call === upWorker(NEW), [OLD, NEW])
    const result = deploy(dir, fake.run, fake)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    assert.deepEqual(steps(fake).slice(6), [
      up(NEW),
      HEALTH,
      upWorker(NEW),
      'docker compose stop litestream',
      'docker compose stop midden-worker',
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      UP_LITESTREAM,
      SETTLE,
      up(OLD),
      HEALTH,
      upWorker(OLD),
    ])
    // The database is put back only once all three have stopped.
    assert.equal(
      fake.seen['stop midden']!.database,
      'migrated by the new version',
    )
    assert.equal(
      readFileSync(path.join(data, 'midden.db'), 'utf8'),
      'as the old version left it',
    )
  })
})
