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
const up = (revision: string) =>
  `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${revision}]`
const isCheckpoint = (call: string) =>
  call.startsWith(
    'docker compose run --rm --no-deps -T --entrypoint node midden -e ',
  ) && call.includes('wal_checkpoint(TRUNCATE)')

interface Fake {
  calls: string[]
  /** State of the data directory seen by named commands. */
  seen: Record<string, { database: string; wal: boolean; state: boolean }>
}

/**
 * A deployment host with OLD running and NEW published: commands are
 * recorded, answered from these canned replies, and `fail` makes a command
 * throw. Starting NEW migrates the database first, failing or not; the
 * checkpoint empties the WAL.
 */
function host(
  dir: string,
  fail: (call: string) => boolean,
): Fake & { run: Run } {
  const data = path.join(dir, 'data')
  const database = path.join(data, 'midden.db')
  const fake: Fake = { calls: [], seen: {} }
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
    if (call.startsWith('docker inspect container')) return 'sha256:old'
    if (isCheckpoint(call)) {
      look('checkpoint')
      writeFileSync(`${database}-wal`, '')
      return '{"busy":0,"log":0,"checkpointed":0}'
    }
    if (call === 'docker compose stop midden') look('stop midden')
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
  const snapshots = () =>
    readdirSync(path.join(data, 'backups', 'deploy')).filter((name) =>
      name.endsWith('.db'),
    )
  const unhealthy = (call: string) =>
    call.startsWith('docker compose up -d --pull never') &&
    call.endsWith(`[${IMAGE}:sha-${NEW}]`)

  test('without Litestream a rollback restores the copy taken while stopped', () => {
    env('SECRET_KEY=x\n')
    const fake = host(dir, unhealthy)
    const result = deploy(dir, fake.run)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    assert.deepEqual(
      fake.calls.map((call) =>
        isCheckpoint(call)
          ? `checkpoint ${call.slice(call.lastIndexOf('['))}`
          : call,
      ),
      [
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
        'docker compose stop midden',
        `checkpoint [${IMAGE}:sha-${OLD}]`,
        `git checkout --quiet --detach ${NEW}`,
        up(NEW),
        'docker compose stop midden',
        `git checkout --quiet --detach ${OLD}`,
        up(OLD),
        HEALTH,
      ],
    )
    // The checkpoint ran with the app stopped, the WAL still full.
    assert.deepEqual(fake.seen.checkpoint, {
      database: 'as the old version left it',
      wal: true,
      state: true,
    })
    assert.equal(
      readFileSync(path.join(data, 'midden.db'), 'utf8'),
      'as the old version left it',
    )
    assert.ok(!existsSync(path.join(data, 'midden.db-wal')))
    // The previous deployment's snapshot stays as well, without a WAL: the
    // checkpoint emptied it.
    assert.equal(snapshots().length, 2)
    assert.ok(snapshots().includes('midden-2026-11-02.db'))
    assert.ok(
      readdirSync(path.join(data, 'backups', 'deploy')).every(
        (name) => !name.endsWith('-wal'),
      ),
    )
  })

  test('a rollback stops Litestream first and starts it once the old version runs', () => {
    env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
    const fake = host(dir, unhealthy)
    const result = deploy(dir, fake.run)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    const compose = fake.calls.filter(
      (call) =>
        call.startsWith('docker compose up') ||
        call.startsWith('docker compose stop') ||
        call.startsWith('git checkout'),
    )
    assert.deepEqual(compose, [
      // The app first: Litestream copies what it wrote last.
      'docker compose stop midden',
      'docker compose stop litestream',
      `git checkout --quiet --detach ${NEW}`,
      `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${NEW}]`,
      'docker compose stop litestream',
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${OLD}]`,
      'docker compose up -d litestream',
    ])
    // The files are put back only once both have stopped.
    assert.deepEqual(fake.seen['stop litestream'], {
      database: 'migrated by the new version',
      wal: true,
      state: true,
    })
    // Litestream comes back to the restored file without its old state,
    // so it starts over from the bucket with a full copy.
    assert.deepEqual(fake.seen['up litestream'], {
      database: 'as the old version left it',
      wal: false,
      state: false,
    })
    // Only this deployment's snapshot is kept.
    assert.equal(snapshots().length, 1)
  })

  test('Litestream is started again even when the old version fails too', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const fake = host(dir, (call) =>
      call.startsWith('docker compose up -d --pull never'),
    )
    assert.throws(() => deploy(dir, fake.run), /docker compose up/)
    assert.equal(fake.calls.at(-1), 'docker compose up -d litestream')
  })

  test('a deployment starts Litestream after the app is healthy', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const fake = host(dir, () => false)
    const result = deploy(dir, fake.run)

    assert.equal(result, `deployed ${NEW} (was ${OLD})`)
    assert.deepEqual(fake.calls.slice(-3), [
      `docker image prune --force --filter label=org.opencontainers.image.source=https://github.com/sxzz/midden`,
      `git diff --quiet ${OLD} ${NEW} -- litestream.yml`,
      'docker compose up -d litestream',
    ])
    // Stopped for the copy, and started only once the new version is up.
    const stopped = fake.calls.indexOf('docker compose stop litestream')
    assert.ok(stopped > fake.calls.indexOf('docker compose stop midden'))
    assert.ok(stopped < fake.calls.findIndex(isCheckpoint))
    assert.equal(snapshots().length, 1)
  })

  test('a changed litestream.yml recreates the sidecar', () => {
    process.env.COMPOSE_PROFILES = 'litestream'
    const fake = host(dir, (call) => call.startsWith('git diff'))
    deploy(dir, fake.run)
    assert.equal(
      fake.calls.at(-1),
      'docker compose up -d --force-recreate litestream',
    )
  })

  test('Litestream failing to start does not fail the deployment', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const fake = host(dir, (call) => call === 'docker compose up -d litestream')
    assert.equal(
      deploy(dir, fake.run),
      `deployed ${NEW} (was ${OLD}); litestream did not start`,
    )
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
    assert.equal(fake.calls.at(-1), HEALTH)
  })

  test('a failed checkpoint keeps the WAL with the copy, and a rollback puts both back', () => {
    env('SECRET_KEY=x\n')
    const fake = host(dir, (call) => unhealthy(call) || isCheckpoint(call))
    const result = deploy(dir, fake.run)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    assert.equal(
      readFileSync(path.join(data, 'midden.db'), 'utf8'),
      'as the old version left it',
    )
    assert.equal(readFileSync(path.join(data, 'midden.db-wal'), 'utf8'), 'wal')
    assert.ok(!existsSync(path.join(data, 'midden.db-shm')))
    const copy = snapshots().find((name) => name !== 'midden-2026-11-02.db')!
    assert.equal(
      readFileSync(path.join(data, 'backups', 'deploy', `${copy}-wal`), 'utf8'),
      'wal',
    )
  })

  test('without a WAL left there is no checkpoint', () => {
    env('SECRET_KEY=x\n')
    rmSync(path.join(data, 'midden.db-wal'))
    const fake = host(dir, () => false)
    assert.equal(deploy(dir, fake.run), `deployed ${NEW} (was ${OLD})`)
    assert.ok(!fake.calls.some(isCheckpoint))
  })

  test('the running version starts again when the copy fails', () => {
    env('COMPOSE_PROFILES=litestream\n')
    const backups = path.join(data, 'backups')
    rmSync(backups, { recursive: true })
    writeFileSync(backups, 'not a directory')
    const fake = host(dir, () => false)

    assert.throws(
      () => deploy(dir, fake.run),
      new RegExp(`could not back up the database; ${OLD} is running again`),
    )
    assert.deepEqual(fake.calls.slice(-4), [
      `git checkout --quiet --detach ${OLD}`,
      up(OLD),
      HEALTH,
      'docker compose up -d litestream',
    ])
    assert.ok(!fake.calls.includes(up(NEW)))
  })
})
