import { Buffer } from 'node:buffer'
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { apiTokens, webSessions } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

const INIT_DATA_MAX_AGE = 300
const WIDGET_MAX_AGE = 24 * 60 * 60
const CLOCK_SKEW = 30
export const SESSION_TTL = 12 * 60 * 60
const HEX_HASH = /^[\da-f]{64}$/i
const DIGITS = /^\d+$/

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

function signatureMatches(expected: Buffer, hash: string | undefined): boolean {
  if (!hash || !HEX_HASH.test(hash)) return false
  return timingSafeEqual(expected, Buffer.from(hash, 'hex'))
}

function fresh(authDate: string | undefined, maxAge: number, now: number) {
  const ts = Number(authDate)
  const seconds = Math.floor(now / 1000)
  return (
    Number.isSafeInteger(ts) &&
    ts <= seconds + CLOCK_SKEW &&
    ts >= seconds - maxAge
  )
}

/** The user id in Mini App initData, if Telegram signed it recently. */
export function initDataUser(
  raw: string,
  token: string,
  now = Date.now(),
): string | undefined {
  const params = new URLSearchParams(raw)
  const keys = [...new Set(params.keys())]
  if (keys.some((key) => params.getAll(key).length !== 1)) return undefined
  const check = keys
    .filter((key) => key !== 'hash')
    .toSorted()
    .map((key) => `${key}=${params.get(key)}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!signatureMatches(expected, params.get('hash') ?? undefined))
    return undefined
  if (!fresh(params.get('auth_date') ?? undefined, INIT_DATA_MAX_AGE, now))
    return undefined
  try {
    const id = JSON.parse(params.get('user') ?? '')?.id
    return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined
  } catch {
    return undefined
  }
}

/** The user id of a Telegram Login Widget authorization, if valid. */
export function widgetUser(
  fields: Record<string, unknown>,
  token: string,
  now = Date.now(),
): string | undefined {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') values[key] = value
    else if (typeof value === 'number' && Number.isFinite(value))
      values[key] = String(value)
    else return undefined
  }
  const check = Object.keys(values)
    .filter((key) => key !== 'hash')
    .toSorted()
    .map((key) => `${key}=${values[key]}`)
    .join('\n')
  const secret = createHash('sha256').update(token).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!signatureMatches(expected, values.hash)) return undefined
  if (!fresh(values.auth_date, WIDGET_MAX_AGE, now)) return undefined
  return DIGITS.test(values.id ?? '') && values.id !== '0'
    ? values.id
    : undefined
}

export function createSession(db: Database, now = Date.now()): string {
  const value = randomBytes(32).toString('hex')
  db.insert(webSessions)
    .values({
      digest: digest(value),
      expiresAt: new Date(now + SESSION_TTL * 1000),
    })
    .run()
  return value
}

export function sessionValid(
  db: Database,
  value: string,
  now = Date.now(),
): boolean {
  const row = db
    .select()
    .from(webSessions)
    .where(eq(webSessions.digest, digest(value)))
    .get()
  return !!row && row.expiresAt.getTime() > now
}

export function deleteSession(db: Database, value: string): void {
  db.delete(webSessions)
    .where(eq(webSessions.digest, digest(value)))
    .run()
}

export function pruneSessions(db: Database, now = Date.now()): void {
  db.delete(webSessions)
    .where(lt(webSessions.expiresAt, new Date(now)))
    .run()
}

/** Make an API token; only its digest is kept, so show it once. */
export function createToken(db: Database, name: string): string {
  const value = `md_${randomBytes(24).toString('base64url')}`
  db.insert(apiTokens)
    .values({ id: newId(), digest: digest(value), name })
    .run()
  return value
}

export function tokenValid(db: Database, value: string): boolean {
  return !!db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.digest, digest(value)))
    .get()
}
