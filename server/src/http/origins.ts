import { asc, count, eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { newId } from '#db/id.ts'
import { passkeys, passkeyTokens, webOrigins } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

export interface OriginView {
  /** Absent for WEB_APP_URL's origin, which cannot be removed. */
  id?: string
  origin: string
  /** Passkeys that removing this origin deletes. */
  passkeys: number
  created_at?: string
}

const LOCALHOST = /^http:\/\/localhost(?::\d+)?$/

/**
 * The origin of an https address (or a local development one), or nothing
 * when the input is not one.
 */
export function normalizeOrigin(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return undefined
  }
  if (url.username || url.password || !url.hostname) return undefined
  if (url.protocol === 'https:') return url.origin
  return LOCALHOST.test(url.origin) ? url.origin : undefined
}

const builtinOf = (webAppUrl: string | undefined) =>
  webAppUrl ? new URL(webAppUrl).origin : undefined

/** Every allowed origin, WEB_APP_URL's first. */
export function allowedOrigins(
  db: Database,
  webAppUrl: string | undefined,
): string[] {
  const builtin = builtinOf(webAppUrl)
  const extra = db
    .select({ origin: webOrigins.origin })
    .from(webOrigins)
    .orderBy(asc(webOrigins.createdAt), asc(webOrigins.id))
    .all()
    .map((row) => row.origin)
    .filter((origin) => origin !== builtin)
  return builtin ? [builtin, ...extra] : extra
}

const hostOf = (origin: string) => new URL(origin).hostname

/** Passkeys bound to this origin's RP ID that no other origin shares. */
function orphanedPasskeys(db: Database, origin: string, others: string[]) {
  const host = hostOf(origin)
  if (others.some((other) => hostOf(other) === host)) return 0
  return db
    .select({ n: count() })
    .from(passkeys)
    .where(eq(passkeys.rpId, host))
    .get()!.n
}

export function listOrigins(
  db: Database,
  webAppUrl: string | undefined,
): OriginView[] {
  const builtin = builtinOf(webAppUrl)
  const all = allowedOrigins(db, webAppUrl)
  const others = (origin: string) => all.filter((o) => o !== origin)
  const rows = db
    .select()
    .from(webOrigins)
    .orderBy(asc(webOrigins.createdAt), asc(webOrigins.id))
    .all()
    .filter((row) => row.origin !== builtin)
  return [
    ...(builtin ? [{ origin: builtin, passkeys: 0 }] : []),
    ...rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      passkeys: orphanedPasskeys(db, row.origin, others(row.origin)),
      created_at: row.createdAt.toISOString(),
    })),
  ]
}

export function addOrigin(
  db: Database,
  webAppUrl: string | undefined,
  input: string,
  now = Date.now(),
): OriginView {
  const origin = normalizeOrigin(input)
  if (!origin)
    throw new HTTPException(400, { message: '请输入 https 开头的地址' })
  if (allowedOrigins(db, webAppUrl).includes(origin))
    throw new HTTPException(409, { message: '这个域名已经在列表中' })
  const row = db
    .insert(webOrigins)
    .values({ id: newId(), origin, createdAt: new Date(now) })
    .returning()
    .get()
  return {
    id: row.id,
    origin,
    passkeys: 0,
    created_at: row.createdAt.toISOString(),
  }
}

/**
 * Stop serving an origin: its passkeys are deleted and its /passkey links
 * stop working. Passkeys stay when another allowed origin has the same host.
 */
export function removeOrigin(
  db: Database,
  webAppUrl: string | undefined,
  id: string,
): { origin: string; passkeys: number } | undefined {
  return db.transaction((tx) => {
    const row = tx
      .delete(webOrigins)
      .where(eq(webOrigins.id, id))
      .returning()
      .get()
    if (!row) return
    tx.delete(passkeyTokens).where(eq(passkeyTokens.origin, row.origin)).run()
    const host = hostOf(row.origin)
    const remaining = tx
      .select({ origin: webOrigins.origin })
      .from(webOrigins)
      .all()
      .map((other) => other.origin)
    const builtin = builtinOf(webAppUrl)
    const shared = [...remaining, ...(builtin ? [builtin] : [])].some(
      (other) => hostOf(other) === host,
    )
    const deleted = shared
      ? []
      : tx
          .delete(passkeys)
          .where(eq(passkeys.rpId, host))
          .returning({ id: passkeys.id })
          .all()
    return { origin: row.origin, passkeys: deleted.length }
  })
}
