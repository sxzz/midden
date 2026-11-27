import { createHash, randomBytes } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { apiTokens } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Database, Executor } from '#db/client.ts'

/**
 * `ro` reads; `rw` reads and writes, but never deletes, nor manages tokens,
 * sessions, passkeys or domains (see `ownerOnly`).
 */
export type Permission = 'ro' | 'rw'
export const PERMISSIONS: readonly Permission[] = ['ro', 'rw']

/** What a request authenticated with a token knows of it. */
export interface TokenInfo {
  id: string
  label: string
  permission: Permission
  createdAt: Date
  expiresAt: Date | null
}

export interface TokenView {
  id: string
  label: string
  permission: Permission
  created_at: string
  /** Null: never expires. */
  expires_at: string | null
  expired: boolean
  last_used_at: string | null
}

/** A token as made or rolled: the secret is shown this once. */
export interface IssuedToken {
  token: TokenView
  secret: string
}

const MAX_LABEL = 64
/** Far enough for any real expiry; Date stops at +275760. */
const LATEST = Date.UTC(9999, 11, 31)

/**
 * A secret: `mdn_`, the permission, and 32 random bytes. The prefix makes a
 * leaked token recognisable (secret scanners, logs) and says what it may do
 * at a glance; the stored permission is what counts.
 */
function newSecret(permission: Permission): string {
  return `mdn_${permission}_${randomBytes(32).toString('base64url')}`
}

export const tokenDigest = (secret: string) =>
  createHash('sha256').update(secret).digest('hex')

/** A label as stored: trimmed, 1 to 64 characters. */
function checkLabel(raw: string): string {
  const label = raw.trim()
  if (!label || [...label].length > MAX_LABEL || label.includes('\0'))
    throw new AppError('invalid_request', '名称不能为空，最多 64 字')
  return label
}

/** An expiry: a time after `now`, or null for never. */
export function checkExpiry(value: Date | null, now = Date.now()): Date | null {
  if (value === null) return null
  const at = value.getTime()
  if (!Number.isFinite(at) || at > LATEST)
    throw new AppError('invalid_request', '过期时间无效')
  if (at <= now) throw new AppError('invalid_request', '过期时间必须晚于现在')
  return value
}

const DURATION = /^(\d{1,6})([mhd])$/
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i

/**
 * The CLI's `--expires`: `never`, a duration from now (`30m`, `12h`, `7d`),
 * or an ISO time (a date alone is its midnight UTC).
 */
export function parseExpiry(raw: string, now = Date.now()): Date | null {
  const value = raw.trim()
  if (value === 'never') return null
  const duration = DURATION.exec(value)
  if (duration) {
    const amount = Number(duration[1])
    if (!amount) throw new AppError('invalid_request', '过期时间必须晚于现在')
    return checkExpiry(
      new Date(now + amount * UNIT[duration[2] as keyof typeof UNIT]),
      now,
    )
  }
  if (!ISO_TIME.test(value))
    throw new AppError('invalid_request', '过期时间无效')
  return checkExpiry(new Date(value), now)
}

type Row = typeof apiTokens.$inferSelect

export function tokenView(row: Row, now = Date.now()): TokenView {
  return {
    id: row.id,
    label: row.label,
    permission: row.permission,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
    expired: !!row.expiresAt && row.expiresAt.getTime() <= now,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
  }
}

function find(db: Executor, id: string): Row {
  const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()
  if (!row) throw new AppError('not_found')
  return row
}

/** Make a token; only the digest of its secret is kept, so show it once. */
export function createToken(
  db: Database,
  input: { label: string; permission: Permission; expiresAt?: Date | null },
  now = Date.now(),
): IssuedToken {
  const label = checkLabel(input.label)
  const expiresAt = checkExpiry(input.expiresAt ?? null, now)
  const secret = newSecret(input.permission)
  const row = db
    .insert(apiTokens)
    .values({
      id: newId(),
      digest: tokenDigest(secret),
      label,
      permission: input.permission,
      createdAt: new Date(now),
      expiresAt,
    })
    .returning()
    .get()
  return { token: tokenView(row, now), secret }
}

/** Every token, oldest first. */
export function listTokens(db: Executor, now = Date.now()): TokenView[] {
  return db
    .select()
    .from(apiTokens)
    .orderBy(asc(apiTokens.createdAt), asc(apiTokens.id))
    .all()
    .map((row) => tokenView(row, now))
}

/**
 * Rename a token, or move its expiry (later, earlier, or `null` for never);
 * the secret stays. An expired token given a new expiry works again.
 */
export function updateToken(
  db: Database,
  id: string,
  update: { label?: string; expiresAt?: Date | null },
  now = Date.now(),
): TokenView {
  const label =
    update.label === undefined ? undefined : checkLabel(update.label)
  const expiresAt =
    update.expiresAt === undefined
      ? undefined
      : checkExpiry(update.expiresAt, now)
  const row = db
    .update(apiTokens)
    .set({ label, expiresAt })
    .where(eq(apiTokens.id, id))
    .returning()
    .get()
  if (!row) throw new AppError('not_found')
  return tokenView(row, now)
}

/**
 * A new secret for the same token: label, permission, expiry and usage stay,
 * and the old secret stops working at once.
 */
export function rollToken(
  db: Database,
  id: string,
  now = Date.now(),
): IssuedToken {
  const { permission } = find(db, id)
  const secret = newSecret(permission)
  const row = db
    .update(apiTokens)
    .set({ digest: tokenDigest(secret) })
    .where(eq(apiTokens.id, id))
    .returning()
    .get()
  if (!row) throw new AppError('not_found')
  return { token: tokenView(row, now), secret }
}

/** Revoke a token: it and its usage are gone. */
export function revokeToken(db: Database, id: string): void {
  const row = db.delete(apiTokens).where(eq(apiTokens.id, id)).returning().get()
  if (!row) throw new AppError('not_found')
}

export type Authentication =
  | { ok: true; token: TokenInfo }
  | { ok: false; error: 'token_invalid' | 'token_expired' }

/**
 * The token a secret belongs to: one indexed look-up by its digest. A
 * revoked or rolled secret is not found; an expired token is known, so the
 * caller can say why.
 */
export function authenticate(
  db: Executor,
  secret: string,
  now = Date.now(),
): Authentication {
  if (!secret) return { ok: false, error: 'token_invalid' }
  const row = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.digest, tokenDigest(secret)))
    .get()
  if (!row) return { ok: false, error: 'token_invalid' }
  if (row.expiresAt && row.expiresAt.getTime() <= now)
    return { ok: false, error: 'token_expired' }
  return {
    ok: true,
    token: {
      id: row.id,
      label: row.label,
      permission: row.permission,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
  }
}

/** The secret in an `Authorization: Bearer` header, or '' when malformed. */
export function bearer(header: string): string {
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}
