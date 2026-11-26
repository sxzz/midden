import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { maintain } from './maintain.ts'
import type { Run } from './deploy.ts'

const IMAGE = 'ghcr.io/sxzz/midden'
const CURRENT = 'a'.repeat(40)
const MAINTAIN = `docker compose run --rm --no-deps -T midden node server/src/cli.ts maintain --vacuum [${IMAGE}:sha-${CURRENT}]`
const upService = (service: string) =>
  `docker compose up -d --pull never --wait --wait-timeout 180 ${service} [${IMAGE}:sha-${CURRENT}]`

describe('maintain', () => {
  let dir: string
  let state: string
  let profiles: string | undefined

  beforeEach(() => {
    mock.method(console, 'info', () => {})
    mock.method(console, 'error', () => {})
    profiles = process.env.COMPOSE_PROFILES
    delete process.env.COMPOSE_PROFILES
    dir = mkdtempSync(path.join(tmpdir(), 'midden-maintain-'))
    state = path.join(dir, 'data', '.midden.db-litestream')
    mkdirSync(state, { recursive: true })
    writeFileSync(path.join(dir, '.env'), 'COMPOSE_PROFILES=litestream\n')
  })
  afterEach(() => {
    mock.restoreAll()
    if (profiles === undefined) delete process.env.COMPOSE_PROFILES
    else process.env.COMPOSE_PROFILES = profiles
    rmSync(dir, { recursive: true, force: true })
  })

  /** A host running CURRENT with a worker; `fail` makes a command throw. */
  function host(fail: (call: string) => boolean = () => false) {
    const calls: string[] = []
    const run: Run = (command, args, env) => {
      const call = [command, ...args].join(' ')
      calls.push(env?.MIDDEN_IMAGE ? `${call} [${env.MIDDEN_IMAGE}]` : call)
      if (call.startsWith('docker compose run'))
        // The state is still there while the maintenance runs.
        assert.equal(existsSync(state), true)
      if (fail(calls.at(-1)!)) throw new Error(`${call} failed`)
      if (call.startsWith('docker image inspect')) return CURRENT
      if (call === 'docker compose ps -q midden') return 'container'
      if (call.startsWith('docker inspect container')) return 'sha256:current'
      if (call === 'docker compose config --services')
        return 'midden\nmidden-worker\nlitestream'
      if (command === 'curl') return 'ok'
      return ''
    }
    const sleep = (ms: number) => calls.push(`sleep ${ms}`)
    const steps = () =>
      calls.filter(
        (call) =>
          call.startsWith('docker compose up') ||
          call.startsWith('docker compose stop') ||
          call.startsWith('docker compose run') ||
          call.startsWith('sleep ') ||
          call.startsWith('curl'),
      )
    return { run, sleep, steps }
  }

  test('stops everything, maintains, and starts Litestream first again', () => {
    const fake = host()
    const result = maintain(dir, fake.run, { sleep: fake.sleep })
    assert.equal(result, `maintained the database; ${CURRENT} is running again`)
    assert.deepEqual(fake.steps(), [
      'docker compose stop midden-worker',
      'docker compose stop midden',
      'docker compose stop litestream',
      MAINTAIN,
      'docker compose up -d litestream',
      'sleep 15000',
      upService('midden'),
      'curl -fsS --max-time 5 http://127.0.0.1:8080/healthz',
      upService('midden-worker'),
    ])
    // Its state described the file before; Litestream starts over from
    // the bucket's position.
    assert.equal(existsSync(state), false)
  })

  test('a failed maintenance still starts the version again', () => {
    const fake = host((call) => call === MAINTAIN)
    const result = maintain(dir, fake.run, { sleep: fake.sleep })
    assert.match(result, /^failed: maintenance did not finish/)
    assert.match(result, /is running again$/)
    assert.equal(fake.steps().at(-1), upService('midden-worker'))
  })

  test('nothing running: nothing to maintain', () => {
    const fake = host()
    const run: Run = (command, args, env) =>
      [command, ...args].join(' ') === 'docker compose ps -q midden'
        ? ''
        : fake.run(command, args, env)
    assert.throws(() => maintain(dir, run), /no version is running/)
    assert.deepEqual(fake.steps(), [])
  })
})
