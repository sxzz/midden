import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, lt, ne } from 'drizzle-orm'
import { setCookie } from 'hono/cookie'
import { newId } from '#db/id.ts'
import { users, webSessions, type UserRole } from '#db/schema.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Context } from 'hono'

const DAY = 24 * 60 * 60

/**
 * A web session ends after this long without a request, in seconds. There
 * is no limit on its whole life: the owner revokes sessions in 设置 →
 * 通行密钥 → 已登录的设备 instead.
 */
export const SESSION_TTL = 30 * DAY

/**
 * A request renews its session (expiry back to `SESSION_TTL` from now, a
 * fresh cookie, `last_used_at`) once this long has passed since the last
 * renewal. So a session in use costs one small write a day, not one per
 * request, and `last_used_at` is as coarse as this.
 */
export const SESSION_RENEW_AFTER = DAY

/** Host-only, so each of the app's domains keeps its own session. */
export const SESSION_COOKIE = '__Host-midden'

export type SignIn = NonNullable<(typeof webSessions.$inferSelect)['method']>

/** Where and how a browser signed in, kept to tell its session apart. */
export interface SessionStart {
  method: SignIn
  origin: string
  userAgent?: string
}

/** A session as 设置 lists it; never its digest. */
export interface SessionView {
  id: string
  current: boolean
  method: SignIn | null
  origin: string | null
  device: string | null
  created_at: string
  last_used_at: string
  expires_at: string
}

const digestOf = (value: string) =>
  createHash('sha256').update(value).digest('hex')

/**
 * Store a new session of `user`; returns the cookie value, which is not
 * stored.
 */
export function createSession(
  db: Executor,
  user: string,
  start?: SessionStart,
  now = Date.now(),
): string {
  const value = randomBytes(32).toString('hex')
  db.insert(webSessions)
    .values({
      digest: digestOf(value),
      id: newId(),
      userId: user,
      expiresAt: new Date(now + SESSION_TTL * 1000),
      createdAt: new Date(now),
      lastUsedAt: new Date(now),
      method: start?.method,
      origin: start?.origin,
      device: start && deviceOf(start.userAgent, start.method),
    })
    .run()
  return value
}

/**
 * The cookie, with a Max-Age equal to what the server keeps, so the
 * browser holds it as long. SameSite=None lets the Mini App keep its
 * session inside Telegram's web client, which frames it from another site.
 */
export function setSessionCookie(c: Context, value: string) {
  setCookie(c, SESSION_COOKIE, value, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    maxAge: SESSION_TTL,
  })
}

/** Sign the browser in as `user`. */
export function startSession(
  c: Context,
  db: Database,
  user: string,
  start: SessionStart,
  now = Date.now(),
) {
  setSessionCookie(c, createSession(db, user, start, now))
}

export interface CheckedSession {
  /** The session's public id. */
  id: string
  /** Whose it is, and their role now. */
  userId: string
  role: UserRole
  /** This request renewed it: the response carries a fresh cookie. */
  renewed: boolean
}

/**
 * The session a cookie names, if it has not expired, renewed when the last
 * renewal is `SESSION_RENEW_AFTER` old. The renewal is judged by the
 * expiry, not `last_used_at`, so a session whose expiry is short of a full
 * `SESSION_TTL` by a day or more renews: sessions from before sliding
 * expiry (12 hours) renew on their first request. A renewal that cannot
 * write (the database is busy) is skipped; the next request tries again.
 * A revoked user's session is none (revoking deletes it too).
 */
export function checkSession(
  db: Database,
  value: string,
  now = Date.now(),
): CheckedSession | undefined {
  const digest = digestOf(value)
  const row = db
    .select({
      id: webSessions.id,
      expiresAt: webSessions.expiresAt,
      userId: webSessions.userId,
      role: users.role,
      revokedAt: users.revokedAt,
    })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .where(eq(webSessions.digest, digest))
    .get()
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now) return undefined
  const checked = { id: row.id, userId: row.userId, role: row.role }
  const due =
    row.expiresAt.getTime() - now <= (SESSION_TTL - SESSION_RENEW_AFTER) * 1000
  if (!due) return { ...checked, renewed: false }
  try {
    db.update(webSessions)
      .set({
        expiresAt: new Date(now + SESSION_TTL * 1000),
        lastUsedAt: new Date(now),
      })
      .where(eq(webSessions.digest, digest))
      .run()
  } catch {
    return { ...checked, renewed: false }
  }
  return { ...checked, renewed: true }
}

export function deleteSession(db: Executor, value: string): void {
  db.delete(webSessions)
    .where(eq(webSessions.digest, digestOf(value)))
    .run()
}

export function pruneSessions(db: Database, now = Date.now()): void {
  db.delete(webSessions)
    .where(lt(webSessions.expiresAt, new Date(now)))
    .run()
}

/**
 * Sign the Mini App in, in place of the session the browser still carries
 * and of the Mini App's other sessions on that domain from the same kind
 * of device. Telegram's web views may lose the cookie between launches,
 * and every launch then signs in anew; without this each would leave a row
 * for 30 days. Returns the cookie value.
 */
export function replaceMiniAppSession(
  db: Database,
  user: string,
  start: SessionStart,
  cookie: string | undefined,
  now = Date.now(),
): string {
  const device = deviceOf(start.userAgent, start.method)
  return db.transaction((tx) => {
    if (cookie) deleteSession(tx, cookie)
    tx.delete(webSessions)
      .where(
        and(
          eq(webSessions.userId, user),
          eq(webSessions.method, 'telegram'),
          eq(webSessions.origin, start.origin),
          device === null
            ? isNull(webSessions.device)
            : eq(webSessions.device, device),
        ),
      )
      .run()
    return createSession(tx, user, start, now)
  })
}

/** The sessions not expired, this one first, then the most recently used. */
export function listSessions(
  db: Database,
  user: string,
  current: string | undefined,
  now = Date.now(),
): SessionView[] {
  return db
    .select()
    .from(webSessions)
    .where(eq(webSessions.userId, user))
    .orderBy(desc(webSessions.lastUsedAt), desc(webSessions.createdAt))
    .all()
    .filter((row) => row.expiresAt.getTime() > now)
    .map((row) => ({
      id: row.id,
      current: row.id === current,
      method: row.method,
      origin: row.origin,
      device: row.device,
      created_at: row.createdAt.toISOString(),
      last_used_at: row.lastUsedAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
    }))
    .toSorted((a, b) => Number(b.current) - Number(a.current))
}

/** Sign one of `user`'s sessions out; false when they have none by that id. */
export function revokeSession(db: Database, user: string, id: string): boolean {
  const deleted = db
    .delete(webSessions)
    .where(and(eq(webSessions.id, id), eq(webSessions.userId, user)))
    .run()
  return Number(deleted.changes) > 0
}

/** Sign `user` out everywhere but `keep`; how many sessions ended. */
export function revokeOtherSessions(
  db: Executor,
  user: string,
  keep: string | undefined,
): number {
  return Number(
    db
      .delete(webSessions)
      .where(
        and(
          eq(webSessions.userId, user),
          keep ? ne(webSessions.id, keep) : undefined,
        ),
      )
      .run().changes,
  )
}

/**
 * The browser and system a user agent names, as 设置 shows them: `Safari ·
 * macOS`, `Chrome · Android`; Telegram for the Mini App, whose web views
 * name the system and not always a browser. Null when neither is known.
 */
export function deviceOf(
  userAgent: string | undefined,
  method?: SignIn,
): string | null {
  const ua = userAgent ?? ''
  const system = systemOf(ua)
  const app = method === 'telegram' ? 'Telegram' : browserOf(ua)
  const parts = [app, system].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

// The first that matches names it: Edge, Opera and Samsung's say Chrome
// too, and every browser on iOS and Chrome says Safari.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.].*\bSafari\//, 'Safari'],
]
// iPhones say "like Mac OS X", Android "Linux".
const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
]

const browserOf = (ua: string) =>
  BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
const systemOf = (ua: string) =>
  SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1]
