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

interface Fake {
  calls: string[]
  /** State of the data directory seen by named commands. */
  seen: Record<string, { database: string; wal: boolean; state: boolean }>
}

/**
 * A deployment host with OLD running and NEW published: commands are
 * recorded, answered from these canned replies, and `fail` makes a command
 * throw.
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
    if (fail(fake.calls.at(-1)!)) throw new Error(`${call} failed`)
    if (call.startsWith('docker image inspect')) {
      const image = args[2]
      return image === `${IMAGE}:latest` || image.endsWith(NEW) ? NEW : OLD
    }
    if (call === 'docker compose ps -q midden') return 'container'
    if (call.startsWith('docker inspect container')) return 'sha256:old'
    if (call.includes('server/src/cli.ts backup')) {
      const name = `midden-2026-11-25T00-00-0${fake.calls.length % 10}-000Z.db`
      writeFileSync(path.join(data, 'backups', 'deploy', name), 'snapshot')
      return `/data/backups/deploy/${name}`
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
    writeFileSync(path.join(data, 'midden.db'), 'migrated by the new version')
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

  test('without Litestream a rollback runs the same commands as before', () => {
    env('SECRET_KEY=x\n')
    const fake = host(dir, unhealthy)
    const result = deploy(dir, fake.run)

    assert.match(result, new RegExp(`^rolled back ${NEW}: unhealthy`))
    const up = (revision: string) =>
      `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${revision}]`
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
      'docker compose exec -T midden node server/src/cli.ts backup /data/backups/deploy',
      `git checkout --quiet --detach ${NEW}`,
      up(NEW),
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      up(OLD),
      'curl -fsS --max-time 5 http://127.0.0.1:8080/healthz',
    ])
    assert.equal(readFileSync(path.join(data, 'midden.db'), 'utf8'), 'snapshot')
    assert.ok(!existsSync(path.join(data, 'midden.db-wal')))
    // The previous deployment's snapshot stays as well.
    assert.equal(snapshots().length, 2)
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
      `git checkout --quiet --detach ${NEW}`,
      `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${NEW}]`,
      'docker compose stop litestream',
      'docker compose stop midden',
      `git checkout --quiet --detach ${OLD}`,
      `docker compose up -d --pull never --wait --wait-timeout 180 midden [${IMAGE}:sha-${OLD}]`,
      'docker compose up -d litestream',
    ])
    // The files change only once both have stopped.
    assert.deepEqual(fake.seen['stop litestream'], {
      database: 'migrated by the new version',
      wal: true,
      state: true,
    })
    // Litestream comes back to the restored file without its old state,
    // so it starts over from the bucket with a full copy.
    assert.deepEqual(fake.seen['up litestream'], {
      database: 'snapshot',
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
    assert.ok(!fake.calls.includes('docker compose stop litestream'))
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
})
