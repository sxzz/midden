import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
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
import { curlGet, deploy, type Get, type Response, type Run } from './deploy.ts'

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
const TOKEN = 'mdn_ro_smoke-test-secret'
const CLI = 'docker compose exec -T midden midden'
const CREATE = new RegExp(
  String.raw`^${CLI} token create --ro --label (deploy-smoke-${NEW.slice(0, 12)}-\w+) --expires 15m$`,
)
const LIST = '/v1/collections?limit=20'
const PROFILES = '/v1/collections?q=type%3Aprofile&limit=1'
const GRAPH = `/v1/collections/graph?of=${encodeURIComponent('x/x.profile/42')}&kinds=following,followers&limit=50`
// Every request, in order, on a library with a collection and an account.
const SMOKE = [
  '/v1/session',
  LIST,
  '/v1/collections/count',
  '/v1/library/stats',
  '/v1/folders',
  '/v1/captures',
  '/v1/collections/c1',
  PROFILES,
  GRAPH,
  '/agent/v1/whoami',
  '/agent/v1/posts?size=5',
  '/agent/v1/aggregate?by=month',
].map((target) => `GET ${target}`)
const DEPLOYED = `deployed ${NEW} (was ${OLD}); smoke 12/12, slowest graph 0.4s`

interface Fake {
  /** Commands, requests as `GET <path>`, and waits as `sleep <ms>`. */
  calls: string[]
  sleep: (ms: number) => void
  /** State of the data directory seen by named commands. */
  seen: Record<string, { database: string; wal: boolean; state: boolean }>
  /** Answers by path; anything else is 200 `{}`. */
  answers: Record<string, Response>
  get: Get
  clock: () => number
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
  let now = 0
  const fake: Fake = {
    calls: [],
    sleep: (ms) => fake.calls.push(`sleep ${ms}`),
    seen: {},
    answers: {
      [LIST]: { status: 200, body: JSON.stringify({ items: [{ id: 'c1' }] }) },
      [PROFILES]: {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              id: 'p1',
              graph: {
                root: 'r',
                entities: [{ key: 'r', type: 'x.profile', external_id: '42' }],
              },
            },
          ],
        }),
      },
    },
    // Requests take 50 ms, the graph 400 ms.
    get: (url, token) => {
      assert.equal(token, TOKEN)
      const target = url.slice('http://127.0.0.1:8080'.length)
      fake.calls.push(`GET ${target}`)
      now += target.startsWith('/v1/collections/graph') ? 400 : 50
      return fake.answers[target] ?? { status: 200, body: '{}' }
    },
    clock: () => now,
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
    if (CREATE.test(call)) return TOKEN
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

    assert.equal(result, DEPLOYED)
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
      `${DEPLOYED}; litestream did not start`,
    )
    assert.ok(!fake.calls.includes(SETTLE))
  })

  test('a slow health check is tried again before rolling back', () => {
    env('SECRET_KEY=x\n')
    let checks = 0
    const fake = host(dir, (call) => call === HEALTH && ++checks <= 3)
    const waits: number[] = []
    const result = deploy(dir, fake.run, {
      ...fake,
      sleep: (ms) => waits.push(ms),
    })

    assert.equal(result, DEPLOYED)
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
    const result = deploy(dir, fake.run, {
      ...fake,
      sleep: (ms) => waits.push(ms),
    })

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
    assert.equal(deploy(dir, fake.run, fake), DEPLOYED)
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

    assert.equal(result, DEPLOYED)
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

  describe('smoke test', () => {
    /** The token commands and requests, after the new version started. */
    const smoke = (fake: Fake) =>
      fake.calls.filter(
        (call) => call.startsWith(CLI) || call.startsWith('GET '),
      )
    const label = (fake: Fake) =>
      CREATE.exec(fake.calls.find((call) => CREATE.test(call))!)![1]
    /** Everything printed, through console.info and console.error. */
    const printed = () =>
      [console.info, console.error]
        .flatMap((fn) => (fn as any).mock.calls)
        .map((call: { arguments: unknown[] }) => call.arguments.join(' '))
        .join('\n')

    test('after the worker is up, a read-only token reads the main endpoints and is revoked', () => {
      env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
      const fake = host(dir, () => false, [OLD, NEW])
      assert.equal(deploy(dir, fake.run, fake), DEPLOYED)

      const created = fake.calls.findIndex((call) => CREATE.test(call))
      assert.ok(created > fake.calls.indexOf(upWorker(NEW)))
      assert.deepEqual(smoke(fake).slice(1), [
        ...SMOKE,
        `${CLI} token revoke ${label(fake)}`,
      ])
    })

    test('a failing endpoint rolls the deployment back and is named in the result', () => {
      env('SECRET_KEY=x\nCOMPOSE_PROFILES=litestream\n')
      const fake = host(dir, () => false, [OLD, NEW])
      fake.answers['/v1/folders'] = { status: 500, body: '{"error":"x"}' }
      fake.answers['/v1/session'] = { status: 200, body: '<html>' }
      fake.answers['/agent/v1/whoami'] = {
        status: 0,
        body: '',
        error: 'timed out',
      }
      const result = deploy(dir, fake.run, fake)

      assert.match(
        result,
        new RegExp(
          `^rolled back ${NEW}: smoke failed 9/12: GET /v1/session 200, not JSON, GET /v1/folders 500, GET /agent/v1/whoami timed out; running ${OLD} with the database from `,
        ),
      )
      // Every check ran; the token went before anything stopped, then the
      // rollback as for an unhealthy version.
      const revoked = fake.calls.indexOf(`${CLI} token revoke ${label(fake)}`)
      assert.equal(
        fake.calls.lastIndexOf('GET /agent/v1/aggregate?by=month'),
        revoked - 1,
      )
      assert.deepEqual(steps(fake).slice(9), [
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
      assert.ok(
        fake.calls.indexOf('docker compose stop litestream', revoked) > revoked,
      )
      assert.equal(
        readFileSync(path.join(data, 'midden.db'), 'utf8'),
        'as the old version left it',
      )
      // The old version gets no smoke test.
      assert.equal(fake.calls.filter((call) => CREATE.test(call)).length, 1)
    })

    test('the token is revoked when a request throws, and when making it goes wrong', () => {
      env('SECRET_KEY=x\n')
      let fake = host(dir, () => false)
      const get = fake.get
      fake.get = (url, token) => {
        if (url.endsWith('/v1/captures')) throw new Error('boom')
        return get(url, token)
      }
      assert.match(
        deploy(dir, fake.run, fake),
        /^rolled back \w+: smoke failed 11\/12: GET \/v1\/captures boom;/,
      )
      assert.equal(smoke(fake).at(-1), `${CLI} token revoke ${label(fake)}`)

      // A token that is not read only is never used, nor shown.
      fake = host(dir, () => false)
      const run = fake.run
      fake.run = (command, args, extra) =>
        CREATE.test([command, ...args].join(' '))
          ? (run(command, args, extra), 'mdn_rw_not-this-one')
          : run(command, args, extra)
      const result = deploy(dir, fake.run, fake)
      assert.match(
        result,
        /^rolled back \w+: smoke failed: could not make a token: token create printed no read-only token;/,
      )
      assert.deepEqual(smoke(fake).slice(1), [
        `${CLI} token revoke ${label(fake)}`,
      ])
      assert.ok(!`${result}\n${printed()}`.includes('mdn_rw_not-this-one'))
    })

    test('a token that cannot be revoked is reported and does not fail the deployment', () => {
      env('SECRET_KEY=x\n')
      const fake = host(dir, (call) => call.includes(' token revoke '))
      assert.equal(deploy(dir, fake.run, fake), DEPLOYED)
      assert.match(
        printed(),
        /could not revoke the smoke test token deploy-smoke-\w+-\w+ \(it expires in 15m\)/,
      )
    })

    test('the secret is in no command, log line or result', () => {
      env('SECRET_KEY=x\n')
      const ok = host(dir, () => false)
      const deployed = deploy(dir, ok.run, ok)
      const failing = host(dir, () => false)
      failing.answers['/v1/library/stats'] = { status: 503, body: '' }
      const rolledBack = deploy(dir, failing.run, failing)

      assert.match(rolledBack, /GET \/v1\/library\/stats 503/)
      for (const text of [
        deployed,
        rolledBack,
        printed(),
        ...ok.calls,
        ...failing.calls,
      ])
        assert.ok(!text.includes(TOKEN), text)
    })

    test('an empty library skips the detail and the relation graph', () => {
      env('SECRET_KEY=x\n')
      const fake = host(dir, () => false)
      fake.answers[LIST] = { status: 200, body: '{"items":[]}' }
      fake.answers[PROFILES] = { status: 200, body: '{"items":[]}' }
      assert.match(
        deploy(dir, fake.run, fake),
        new RegExp(
          String.raw`^deployed ${NEW} \(was ${OLD}\); smoke 10/10, 2 skipped, slowest session 0\.1s$`,
        ),
      )
      assert.ok(!fake.calls.includes('GET /v1/collections/c1'))
      assert.ok(
        fake.calls.every(
          (call) => !call.startsWith('GET /v1/collections/graph'),
        ),
      )
    })

    test('an account listed without its graph is read whole for its key', () => {
      env('SECRET_KEY=x\n')
      const fake = host(dir, () => false)
      const profile = JSON.parse(fake.answers[PROFILES]!.body).items[0]
      fake.answers['/v1/collections/p1'] = {
        status: 200,
        body: JSON.stringify(profile),
      }
      fake.answers[PROFILES] = { status: 200, body: '{"items":[{"id":"p1"}]}' }
      assert.match(
        deploy(dir, fake.run, fake),
        /; smoke 13\/13, slowest graph 0\.4s$/,
      )
      const read = fake.calls.indexOf('GET /v1/collections/p1')
      assert.ok(read !== -1 && fake.calls[read + 1] === `GET ${GRAPH}`)
    })
  })
})

describe('curlGet', () => {
  // In a child process: curlGet blocks this one until curl returns.
  let server: ChildProcess
  let origin: string
  beforeEach(async () => {
    server = spawn(
      process.execPath,
      [
        '-e',
        `const s = require('node:http').createServer((q, r) => {
          r.statusCode = q.url === '/down' ? 503 : 200
          r.end(JSON.stringify({ authorization: q.headers.authorization }))
        }).listen(0, '127.0.0.1', () => console.log(s.address().port))`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const [port] = (await once(server.stdout!, 'data')) as [unknown]
    origin = `http://127.0.0.1:${String(port).trim()}`
  })
  afterEach(() => {
    server.kill()
  })

  test('sends the token as a bearer header and returns the status and body', () => {
    assert.deepEqual(curlGet(`${origin}/ok`, TOKEN), {
      status: 200,
      body: JSON.stringify({ authorization: `Bearer ${TOKEN}` }),
    })
    assert.equal(curlGet(`${origin}/down`, TOKEN).status, 503)
  })

  test('no answer is an error without the token in it', () => {
    server.kill()
    const response = curlGet('http://127.0.0.1:1/', TOKEN, 2)
    assert.equal(response.status, 0)
    assert.match(response.error!, /curl|connect/i)
    assert.ok(!response.error!.includes(TOKEN))
  })
})
