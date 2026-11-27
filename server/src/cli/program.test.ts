import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { loadConfig } from '#config.ts'
import { openDatabase, type Database } from '#db/client.ts'
import { testContext } from '#testing/context.ts'
import { FakeS3 } from '#testing/fake-s3.ts'
import { authenticate, createToken, listTokens } from '#tokens/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { runCli, type CliContext } from './program.ts'
import type { BucketBlobStore } from '#blob/bucket-store.ts'
import type { Buffer } from 'node:buffer'

const NOW = Date.UTC(2026, 10, 27, 12)
const HOUR = 3_600_000
const SECRET_KEY = 'k'.repeat(48)

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

/** A command line run against `db`, with everything it printed. */
function setup(overrides: Partial<CliContext> = {}) {
  const db = openDatabase(':memory:')
  const out: string[] = []
  const err: string[] = []
  const written: Buffer[] = []
  const ctx: CliContext = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: (bytes) => written.push(bytes),
    config: () => {
      throw new Error('no configuration here')
    },
    db: () => db,
    mediaStore: () => Promise.resolve(undefined),
    rawStore: () => Promise.resolve(undefined),
    now: () => NOW,
    version: 'test',
    ...overrides,
  }
  const run = (...argv: string[]) => runCli(argv, ctx)
  return { db, out, err, written, run }
}

const secrets = (db: Database) =>
  listTokens(db, NOW).map((t) => ({ label: t.label, id: t.id }))

describe('parsing and dispatch', () => {
  test('--help lists every command, each has its own help, --version prints the version', async () => {
    const { out, err, run } = setup()
    expect(await run('--help')).toBe(0)
    const commands = [
      'token create',
      'token list',
      'token revoke',
      'token expires',
      'backup',
      'media-migrate',
      'media-prune-local',
      'raw-get',
      'maintain',
    ]
    for (const name of commands) expect(out.join('\n')).toContain(name)
    for (const name of commands) {
      out.length = 0
      expect(await run(...name.split(' '), '--help')).toBe(0)
      expect(out.join('\n')).toContain(`$ midden ${name}`)
    }
    out.length = 0
    expect(await run('--version')).toBe(0)
    expect(out.join('\n')).toContain('midden/test')
    // Help needs no configuration and writes nothing to stderr.
    expect(err).toEqual([])
  })

  test('mistakes exit with 2, say what is wrong on stderr and print no data', async () => {
    const { out, err, run } = setup()
    for (const [argv, message] of [
      [[], 'no command given'],
      [['frobnicate'], 'unknown command "frobnicate"'],
      [['token'], 'token needs a subcommand'],
      [['token', 'rotate'], 'unknown command "token rotate"'],
      [['token', 'create', '--colour'], 'Unknown option `--colour`'],
      [['token', 'create', '--ro', '--label'], 'value is missing'],
      [['token', 'create'], 'give one of --ro'],
      [['token', 'create', '--ro', '--rw'], 'give one of --ro'],
      [['token', 'revoke'], 'missing required args'],
      [['token', 'expires', 'smoke'], 'missing required args'],
      [['token', 'list', 'extra'], 'Unused args'],
      [['backup'], 'missing required args'],
      [['raw-get', 'c', 'x'], 'position must be a whole number'],
      [['raw-get', 'c', '0', '--json'], '--json is for the listing'],
      [['media-migrate', '--concurrency', '0'], '--concurrency must be'],
      [['media-prune-local', '--limit', 'many'], '--limit must be'],
    ] as const) {
      err.length = 0
      expect(await run(...argv), argv.join(' ')).toBe(2)
      expect(err.join('\n'), argv.join(' ')).toContain(message)
    }
    expect(out).toEqual([])
  })
})

describe('token create', () => {
  test('prints the secret alone on stdout, and what it is on stderr', async () => {
    const { db, out, err, run } = setup()
    expect(
      await run(
        'token',
        'create',
        '--ro',
        '--label',
        'smoke',
        '--expires',
        '1h',
      ),
    ).toBe(0)
    expect(out).toEqual([expect.stringMatching(/^mdn_ro_[\w-]{43}$/)])
    expect(err).toEqual([
      `smoke · ro · expires ${new Date(NOW + HOUR).toISOString()}`,
    ])
    expect(authenticate(db, out[0]!, NOW).ok).toBe(true)
    // After the hour the token no longer authenticates.
    expect(authenticate(db, out[0]!, NOW + HOUR).ok).toBe(false)
  })

  test('defaults: label cli, never expires; --rw makes a read-write token', async () => {
    const { db, run } = setup()
    expect(await run('token', 'create', '--rw')).toBe(0)
    expect(listTokens(db, NOW)).toEqual([
      expect.objectContaining({
        label: 'cli',
        permission: 'rw',
        expires_at: null,
      }),
    ])
  })

  test('a label that looks like a number stays text, and a bad expiry fails with 1', async () => {
    const { db, err, run } = setup()
    expect(await run('token', 'create', '--ro', '--label', '12345')).toBe(0)
    expect(listTokens(db, NOW)[0]!.label).toBe('12345')
    err.length = 0
    expect(await run('token', 'create', '--ro', '--expires', 'yesterday')).toBe(
      1,
    )
    expect(err[0]).toContain('--expires')
    expect(listTokens(db, NOW)).toHaveLength(1)
  })
})

describe('token list', () => {
  /** Ids start with a millisecond timestamp: make them differ within it. */
  const tick = () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3)

  function tokens() {
    const s = setup()
    const a = createToken(
      s.db,
      { label: 'research', permission: 'ro', expiresAt: new Date(NOW + HOUR) },
      NOW - 2 * HOUR,
    )
    tick()
    const b = createToken(s.db, { label: 'sync', permission: 'rw' }, NOW - HOUR)
    tick()
    const c = createToken(
      s.db,
      { label: 'old', permission: 'ro', expiresAt: new Date(NOW - HOUR) },
      NOW - 3 * HOUR,
    )
    return { ...s, a, b, c }
  }

  test('--json is an array of the documented shape, oldest first', async () => {
    const { db, out, run, a } = tokens()
    const usage = new TokenUsage({ db, now: () => NOW })
    usage.record(a.token.id, 'GET /agent/v1/posts')
    usage.record(a.token.id, 'GET /agent/v1/posts')
    usage.flush()
    expect(await run('token', 'list', '--json')).toBe(0)
    expect(out).toHaveLength(1)
    const listed = JSON.parse(out[0]!)
    expect(listed.map((t: { label: string }) => t.label)).toEqual([
      'old',
      'research',
      'sync',
    ])
    expect(listed[1]).toEqual({
      id: expect.stringMatching(/^[\da-f-]{8,}$/),
      label: 'research',
      permission: 'ro',
      created_at: new Date(NOW - 2 * HOUR).toISOString(),
      expires_at: new Date(NOW + HOUR).toISOString(),
      expired: false,
      last_used_at: expect.any(String),
      requests_today: 2,
    })
    expect(listed[0]).toEqual(
      expect.objectContaining({ expired: true, requests_today: 0 }),
    )
    expect(listed[2]).toEqual(
      expect.objectContaining({
        expires_at: null,
        last_used_at: null,
        permission: 'rw',
      }),
    )
  })

  test('shows a table; no secret, digest or full id appears in either form', async () => {
    const { db, out, run, a, b, c } = tokens()
    expect(await run('token', 'list')).toBe(0)
    expect(out[0]).toMatch(
      /^LABEL +ID +PERM +CREATED +EXPIRES +LAST USED +TODAY$/,
    )
    expect(out).toHaveLength(4)
    expect(out.join('\n')).toContain('(expired)')
    expect(out.join('\n')).toContain('never')
    const rows = db.$client.prepare('SELECT digest FROM api_tokens').all() as {
      digest: string
    }[]
    await run('token', 'list', '--json')
    const everything = out.join('\n')
    for (const issued of [a, b, c]) {
      expect(everything).not.toContain(issued.secret)
      expect(everything).not.toContain(issued.token.id)
      expect(everything).not.toMatch(/mdn_(ro|rw)_/)
    }
    for (const { digest } of rows) expect(everything).not.toContain(digest)
  })

  test('says so on stderr when there are none, and the JSON is []', async () => {
    const { out, err, run } = setup()
    expect(await run('token', 'list')).toBe(0)
    expect(out).toEqual([])
    expect(err).toEqual(['no tokens'])
    expect(await run('token', 'list', '--json')).toBe(0)
    expect(out).toEqual(['[]'])
  })

  test('tokens made at the same moment get prefixes long enough to tell apart', async () => {
    const { db, out, run } = setup()
    for (const label of ['a', 'b', 'c'])
      createToken(db, { label, permission: 'ro' }, NOW)
    await run('token', 'list', '--json')
    const ids = JSON.parse(out[0]!).map((t: { id: string }) => t.id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids)
      expect(secrets(db).filter((t) => t.id.startsWith(id))).toHaveLength(1)
  })
})

describe('token revoke', () => {
  test('by label: the secret stops working and the token is gone', async () => {
    const { db, out, err, run } = setup()
    const smoke = createToken(db, { label: 'smoke', permission: 'ro' }, NOW)
    const keep = createToken(db, { label: 'keep', permission: 'rw' }, NOW)
    expect(await run('token', 'revoke', 'smoke')).toBe(0)
    expect(err).toEqual(['revoked smoke (ro)'])
    expect(out).toEqual([])
    expect(authenticate(db, smoke.secret, NOW).ok).toBe(false)
    expect(authenticate(db, keep.secret, NOW).ok).toBe(true)
  })

  test('by the id prefix `token list` prints, and --json says what was revoked', async () => {
    const { db, out, run } = setup()
    // Made back to back, so often in the same millisecond: their ids share a
    // long prefix, and only the one `token list` prints tells them apart.
    for (const label of ['a', 'b', 'c'])
      createToken(db, { label, permission: 'ro' }, NOW)
    await run('token', 'list', '--json')
    const listed = JSON.parse(out.pop()!) as { id: string; label: string }[]
    const a = listed.find((t) => t.label === 'a')!
    expect(await run('token', 'revoke', a.id, '--json')).toBe(0)
    expect(out).toEqual(['{"revoked":"a"}'])
    expect(secrets(db).map((t) => t.label)).toEqual(['b', 'c'])
  })

  test('a prefix that fits several tokens is refused, and nothing is revoked', async () => {
    const { db, err, run } = setup()
    for (const label of ['a', 'b'])
      createToken(db, { label, permission: 'ro' }, NOW)
    // The first 8 characters are the timestamp's start: the same for both.
    const shared = secrets(db)[0]!.id.slice(0, 8)
    expect(await run('token', 'revoke', shared)).toBe(1)
    expect(err[0]).toContain('2 tokens match')
    expect(secrets(db)).toHaveLength(2)
  })

  test('a label shared by several tokens is refused, with the candidates listed', async () => {
    const { db, out, err, run } = setup()
    const first = createToken(db, { label: 'dup', permission: 'ro' }, NOW)
    createToken(db, { label: 'dup', permission: 'rw' }, NOW)
    expect(await run('token', 'revoke', 'dup')).toBe(1)
    expect(secrets(db)).toHaveLength(2)
    expect(out).toEqual([])
    expect(err[0]).toContain('2 tokens match "dup"')
    expect(err.slice(1)).toEqual([
      expect.stringMatching(/ {2}[\da-f-]{8,} {2}dup {2}ro /),
      expect.stringMatching(/ {2}[\da-f-]{8,} {2}dup {2}rw /),
    ])
    // The prefix it printed is enough to pick one.
    const prefix = /([\da-f-]{8,}) {2}dup {2}ro/.exec(err[1]!)![1]!
    expect(first.token.id.startsWith(prefix)).toBe(true)
    expect(await run('token', 'revoke', prefix)).toBe(0)
    expect(secrets(db).map((t) => t.label)).toEqual(['dup'])
  })

  test('nothing matches: exit 1', async () => {
    const { err, run } = setup()
    expect(await run('token', 'revoke', 'ghost')).toBe(1)
    expect(err).toEqual(['no token has the id or label "ghost"'])
  })
})

describe('token expires', () => {
  test('a duration, an ISO time and never', async () => {
    const { db, err, run } = setup()
    createToken(db, { label: 'smoke', permission: 'ro' }, NOW)
    expect(await run('token', 'expires', 'smoke', '7d')).toBe(0)
    expect(listTokens(db, NOW)[0]!.expires_at).toBe(
      new Date(NOW + 7 * 24 * HOUR).toISOString(),
    )
    expect(await run('token', 'expires', 'smoke', '2027-01-01T00:00:00Z')).toBe(
      0,
    )
    expect(listTokens(db, NOW)[0]!.expires_at).toBe('2027-01-01T00:00:00.000Z')
    expect(await run('token', 'expires', 'smoke', 'never')).toBe(0)
    expect(listTokens(db, NOW)[0]!.expires_at).toBeNull()
    expect(err.at(-1)).toBe('smoke: never expires')
  })

  test('--json, an expired token works again, and a bad time changes nothing', async () => {
    const { db, out, err, run } = setup()
    const old = createToken(
      db,
      { label: 'old', permission: 'ro', expiresAt: new Date(NOW + HOUR) },
      NOW,
    )
    const later = NOW + 2 * HOUR
    expect(authenticate(db, old.secret, later)).toEqual({
      ok: false,
      error: 'token_expired',
    })
    // The CLI's clock is NOW, so a duration is counted from there.
    expect(await run('token', 'expires', 'old', '1d', '--json')).toBe(0)
    expect(out).toEqual([
      JSON.stringify({
        label: 'old',
        expires_at: new Date(NOW + 24 * HOUR).toISOString(),
      }),
    ])
    expect(authenticate(db, old.secret, later).ok).toBe(true)

    expect(await run('token', 'expires', 'old', 'soon')).toBe(1)
    expect(await run('token', 'expires', 'old', '2020-01-01')).toBe(1)
    expect(err.at(-1)).toContain('--expires')
    expect(listTokens(db, NOW)[0]!.expires_at).toBe(
      new Date(NOW + 24 * HOUR).toISOString(),
    )
    expect(await run('token', 'expires', 'ghost', '1d')).toBe(1)
  })
})

describe('backup', () => {
  test('writes a copy into the directory and prints its path alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-backup-'))
    const { out, run } = setup()
    expect(await run('backup', path.join(dir, 'nested'))).toBe(0)
    const [file] = readdirSync(path.join(dir, 'nested'))
    expect(file).toMatch(/^midden-2026-11-27T12-00-00-000Z\.db$/)
    expect(out).toEqual([path.join(dir, 'nested', file!)])

    out.length = 0
    expect(await run('backup', dir, '--json')).toBe(0)
    expect(JSON.parse(out[0]!)).toEqual({
      file: path.join(dir, 'midden-2026-11-27T12-00-00-000Z.db'),
    })
  })
})

describe('media-migrate and media-prune-local', () => {
  test('without an R2 media store they fail with 1', async () => {
    const { err, run } = setup()
    expect(await run('media-migrate')).toBe(1)
    expect(await run('media-prune-local', '--dry-run')).toBe(1)
    expect(err).toEqual([
      'media-migrate needs MEDIA_STORE=r2 and the R2 settings',
      'media-prune-local needs MEDIA_STORE=r2 and the R2 settings',
    ])
  })

  test('with one they run the command with the options', async () => {
    const s3 = await new FakeS3().start()
    cleanup.push(() => s3.stop())
    const ctx = testContext({ blobs: (m) => s3.store(m) })
    const { out, run } = setup({
      db: () => ctx.db,
      mediaStore: () => Promise.resolve(ctx.blobs as BucketBlobStore),
    })
    expect(
      await run(
        'media-migrate',
        '--dry-run',
        '--concurrency',
        '2',
        '--limit',
        '5',
      ),
    ).toBe(0)
    expect(out.join('\n')).toContain('[dry run] checked 0 blobs')
    out.length = 0
    expect(await run('media-prune-local', '--verify-download')).toBe(0)
    expect(out.join('\n')).toContain('checked 0 blobs')
  })
})

describe('raw-get', () => {
  test('a capture with nothing: the reason on stderr, exit 1, [] with --json', async () => {
    const { out, err, written, run } = setup()
    expect(await run('raw-get', 'nope')).toBe(1)
    expect(err).toEqual(['no raw responses for capture nope'])
    expect(await run('raw-get', 'nope', '--json')).toBe(1)
    expect(out).toEqual(['[]'])
    expect(await run('raw-get', 'nope', '0')).toBe(1)
    expect(err.at(-1)).toBe('no raw response 0 for capture nope')
    expect(written).toEqual([])
  })
})

describe('maintain', () => {
  test('checks the database file named by the configuration', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-maintain-'))
    const config = loadConfig({ DATA_DIR: dir, SECRET_KEY })
    openDatabase(config.databasePath).$client.close()
    const { out, run } = setup({ config: () => config })
    expect(await run('maintain')).toBe(0)
    expect(out.join('\n')).toContain('integrity check')
  })
})
