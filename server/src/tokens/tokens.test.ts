import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { openDatabase } from '#db/client.ts'
import { apiTokens } from '#db/schema.ts'
import { insertRow, migratedBefore, migrateRest } from '#testing/migrations.ts'
import { adminId } from '#users/users.ts'
import {
  authenticate,
  createToken,
  listTokens,
  parseExpiry,
  revokeToken,
  rollToken,
  updateToken,
} from './tokens.ts'
import { TokenUsage, utcDay } from './usage.ts'

const NOW = Date.UTC(2026, 10, 26, 12)
const HOUR = 3_600_000
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

describe('tokens', () => {
  test('a secret says its permission and is kept only as a digest', () => {
    const db = openDatabase(':memory:')
    const ro = createToken(
      db,
      { user: adminId(db), label: ' reader ', permission: 'ro' },
      NOW,
    )
    const rw = createToken(
      db,
      { user: adminId(db), label: 'writer', permission: 'rw' },
      NOW,
    )
    expect(ro.secret).toMatch(/^mdn_ro_[\w-]{43}$/)
    expect(rw.secret).toMatch(/^mdn_rw_[\w-]{43}$/)
    expect(ro.token).toEqual({
      id: expect.any(String),
      label: 'reader',
      permission: 'ro',
      created_at: new Date(NOW).toISOString(),
      expires_at: null,
      expired: false,
      last_used_at: null,
    })
    const rows = db.select().from(apiTokens).all()
    expect(rows.map((r) => r.digest)).toEqual([
      sha256(ro.secret),
      sha256(rw.secret),
    ])
    expect(JSON.stringify(rows)).not.toContain(ro.secret.slice(7))
    expect(authenticate(db, ro.secret, NOW)).toEqual({
      ok: true,
      token: {
        id: ro.token.id,
        userId: adminId(db),
        role: 'admin',
        label: 'reader',
        permission: 'ro',
        createdAt: new Date(NOW),
        expiresAt: null,
      },
    })
    expect(authenticate(db, `${ro.secret}x`, NOW)).toEqual({
      ok: false,
      error: 'token_invalid',
    })
    expect(authenticate(db, '', NOW).ok).toBe(false)
  })

  test('an expiry is a time ahead; it can move or go', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      createToken(
        db,
        {
          user: adminId(db),
          label: 'old',
          permission: 'ro',
          expiresAt: new Date(NOW - 1),
        },
        NOW,
      ),
    ).toThrow('过期时间必须晚于现在')
    expect(() =>
      createToken(db, { user: adminId(db), label: ' ', permission: 'ro' }, NOW),
    ).toThrow('名称不能为空')
    const { token, secret } = createToken(
      db,
      {
        user: adminId(db),
        label: 'soon',
        permission: 'rw',
        expiresAt: new Date(NOW + HOUR),
      },
      NOW,
    )
    expect(token.expires_at).toBe(new Date(NOW + HOUR).toISOString())
    expect(authenticate(db, secret, NOW + HOUR - 1).ok).toBe(true)
    expect(authenticate(db, secret, NOW + HOUR)).toEqual({
      ok: false,
      error: 'token_expired',
    })
    // Extended, it works again with the same secret.
    const later = NOW + 2 * HOUR
    expect(
      updateToken(
        db,
        adminId(db),
        token.id,
        { expiresAt: new Date(later + HOUR) },
        later,
      ).expired,
    ).toBe(false)
    expect(authenticate(db, secret, later).ok).toBe(true)
    expect(
      updateToken(
        db,
        adminId(db),
        token.id,
        { expiresAt: null, label: 'kept' },
        later,
      ),
    ).toEqual(
      expect.objectContaining({
        label: 'kept',
        expires_at: null,
        expired: false,
      }),
    )
    expect(() =>
      updateToken(
        db,
        adminId(db),
        token.id,
        { expiresAt: new Date(later - 1) },
        later,
      ),
    ).toThrow('过期时间必须晚于现在')
  })

  test('rolling replaces the secret of the same token; revoking ends it', () => {
    const db = openDatabase(':memory:')
    const made = createToken(
      db,
      {
        user: adminId(db),
        label: 'bot',
        permission: 'ro',
        expiresAt: new Date(NOW + HOUR),
      },
      NOW,
    )
    const rolled = rollToken(db, adminId(db), made.token.id, NOW)
    expect(rolled.secret).toMatch(/^mdn_ro_/)
    expect(rolled.secret).not.toBe(made.secret)
    expect(rolled.token).toEqual(made.token)
    expect(authenticate(db, made.secret, NOW).ok).toBe(false)
    expect(authenticate(db, rolled.secret, NOW).ok).toBe(true)
    revokeToken(db, adminId(db), made.token.id)
    expect(authenticate(db, rolled.secret, NOW).ok).toBe(false)
    expect(listTokens(db, adminId(db), NOW)).toEqual([])
    expect(() => rollToken(db, adminId(db), made.token.id, NOW)).toThrow()
    expect(() => revokeToken(db, adminId(db), made.token.id)).toThrow()
  })

  test('the CLI’s expiry', () => {
    expect(parseExpiry('never', NOW)).toBeNull()
    expect(parseExpiry('30m', NOW)).toEqual(new Date(NOW + HOUR / 2))
    expect(parseExpiry('12h', NOW)).toEqual(new Date(NOW + 12 * HOUR))
    expect(parseExpiry('7d', NOW)).toEqual(new Date(NOW + 7 * 24 * HOUR))
    expect(parseExpiry('2027-01-01', NOW)).toEqual(new Date('2027-01-01'))
    expect(parseExpiry('2027-01-01T08:00:00+08:00', NOW)).toEqual(
      new Date(Date.UTC(2027, 0, 1)),
    )
    for (const bad of ['0d', 'soon', '2020-01-01', '7w', '-1d'])
      expect(() => parseExpiry(bad, NOW)).toThrow()
  })
})

describe('usage', () => {
  test('counts per day and endpoint, written in one go', () => {
    const db = openDatabase(':memory:')
    let now = NOW
    const usage = new TokenUsage({ db, now: () => now })
    const a = createToken(
      db,
      { user: adminId(db), label: 'a', permission: 'ro' },
      NOW,
    ).token
    const b = createToken(
      db,
      { user: adminId(db), label: 'b', permission: 'ro' },
      NOW,
    ).token
    usage.record(a.id, 'GET /agent/v1/posts')
    usage.record(a.id, 'GET /agent/v1/posts')
    usage.record(b.id, 'GET /agent/v1/tags')
    // Not written yet, and counted all the same.
    expect(db.all('SELECT * FROM api_token_usage')).toEqual([])
    expect(usage.today(db, a.id)).toBe(2)
    usage.flush()
    expect(
      db.all(
        'SELECT token_id, day, endpoint, count FROM api_token_usage ORDER BY token_id',
      ),
    ).toEqual([
      {
        token_id: a.id,
        day: '2026-11-26',
        endpoint: 'GET /agent/v1/posts',
        count: 2,
      },
      {
        token_id: b.id,
        day: '2026-11-26',
        endpoint: 'GET /agent/v1/tags',
        count: 1,
      },
    ])
    expect(
      listTokens(db, adminId(db)).find((t) => t.id === a.id)!.last_used_at,
    ).toBe(new Date(NOW).toISOString())
    // The next day, and a flush that adds to the row already there.
    usage.record(a.id, 'GET /agent/v1/posts')
    usage.flush()
    now += 24 * HOUR
    usage.record(a.id, 'GET /agent/v1/posts')
    expect(usage.today(db, a.id)).toBe(1)
    const summary = usage.summaries(db, [a.id]).get(a.id)!
    expect(summary.today).toBe(1)
    expect(summary.total).toBe(4)
    expect(summary.days).toHaveLength(30)
    expect(summary.days.slice(-2)).toEqual([
      { day: '2026-11-26', count: 3 },
      { day: utcDay(now), count: 1 },
    ])
    expect(usage.endpoints(db, a.id)).toEqual([
      { endpoint: 'GET /agent/v1/posts', count: 4 },
    ])
    // A token revoked before its counts are written takes them along.
    revokeToken(db, adminId(db), b.id)
    usage.record(b.id, 'GET /agent/v1/tags')
    usage.flush()
    expect(
      db.all(
        `SELECT count(*) AS n FROM api_token_usage WHERE token_id = '${b.id}'`,
      ),
    ).toEqual([{ n: 0 }])
  })

  test('counts wait for the next flush while the database is locked', () => {
    const db = openDatabase(':memory:')
    const usage = new TokenUsage({ db, now: () => NOW })
    const a = createToken(
      db,
      { user: adminId(db), label: 'a', permission: 'ro' },
      NOW,
    ).token
    usage.record(a.id, 'GET /agent/v1/posts')
    const transaction = db.transaction
    db.transaction = (() => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 })
    }) as never
    usage.flush()
    db.transaction = transaction
    expect(usage.today(db, a.id)).toBe(1)
    usage.flush()
    expect(db.all('SELECT count FROM api_token_usage')).toEqual([{ count: 1 }])
  })
})

describe('migration', () => {
  test('tokens made before read and write, never expire and keep their names', () => {
    const db = migratedBefore('agent_tokens')
    const digest = sha256('md_legacy')
    insertRow(db, 'api_tokens', {
      id: 't1',
      digest,
      name: 'dev',
      created_at: NOW,
    })
    migrateRest(db)
    expect(db.select().from(apiTokens).all()).toEqual([
      {
        id: 't1',
        digest,
        userId: adminId(db),
        label: 'dev',
        permission: 'rw',
        createdAt: new Date(NOW),
        expiresAt: null,
        lastUsedAt: null,
      },
    ])
    // The old secret still works.
    expect(authenticate(db, 'md_legacy', NOW)).toEqual({
      ok: true,
      token: expect.objectContaining({ id: 't1', permission: 'rw' }),
    })
  })
})
