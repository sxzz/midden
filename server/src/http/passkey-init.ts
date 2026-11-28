// The first passkey of a fresh install: while the admin has none, nobody can
// sign in on the web, so the web process logs a link that adds one
// (docs/architecture.md, 认证). It opens the same page as a /passkey link and
// goes through the same registration. It has no expiry and is good once: a
// passkey of the admin's, made through it or any other way, ends it for good.
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { passkeys, settings, users } from '#db/schema.ts'
import { newToken } from '#users/invites.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Logger } from '#log.ts'

/**
 * The settings row that holds the link's salt. The token is the HMAC of
 * the salt under a key derived from SECRET_KEY, never stored, not even
 * sealed as an invite's is: there is one link, so nothing to look up by
 * digest. The database alone (a backup, a replica) gives no link, and
 * writing to it mints none, since checking a token takes the key; every
 * start prints the same one, and a new SECRET_KEY ends it.
 */
const SALT = 'passkey_init_salt'

/** What the init link needs: its key, and the one origin it is good on. */
export interface InitLink {
  /** `deriveKey(SECRET_KEY, 'passkey-init')`. */
  key: Buffer
  /** WEB_APP_URL's origin; without one the link is good nowhere. */
  origin?: string
}

// In base 62, as invites' are: a double-click selects the whole token.
const tokenOf = (key: Buffer, salt: string) =>
  newToken(createHmac('sha256', key).update(salt).digest())

/** Whether the admin has a passkey; a viewer's does not count. */
function adminHasPasskey(db: Executor): boolean {
  return !!db
    .select({ id: passkeys.id })
    .from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(eq(users.role, 'admin'))
    .limit(1)
    .get()
}

const saltOf = (db: Executor) =>
  db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SALT))
    .get()?.value

/** End the init link: the admin has a passkey. */
export function forgetInitLink(db: Executor): void {
  db.delete(settings).where(eq(settings.key, SALT)).run()
}

/**
 * The init link's token while the admin has no passkey, made the first
 * time and the same after; none once they have one, and then forgotten.
 * It writes only when that changes anything: at startup the write lock may
 * be someone else's (docs/architecture.md, 启动顺序).
 */
export function initLinkToken(db: Database, key: Buffer): string | undefined {
  const salt = saltOf(db)
  if (adminHasPasskey(db)) {
    if (salt !== undefined) forgetInitLink(db)
    return undefined
  }
  if (salt !== undefined) return tokenOf(key, salt)
  db.insert(settings)
    .values({ key: SALT, value: randomBytes(32).toString('base64url') })
    .onConflictDoNothing()
    .run()
  return tokenOf(key, saltOf(db)!)
}

/** Whether `token` is the init link's, still good on this origin. */
export function isInitToken(
  db: Executor,
  link: InitLink | undefined,
  token: string,
  origin: string,
): boolean {
  if (!link?.origin || origin !== link.origin) return false
  const salt = saltOf(db)
  if (salt === undefined) return false
  const expected = Buffer.from(tokenOf(link.key, salt))
  const given = Buffer.from(token)
  return (
    given.length === expected.length &&
    timingSafeEqual(given, expected) &&
    !adminHasPasskey(db)
  )
}

/**
 * At the web process's start, while the admin has no passkey: one info
 * line with the link, the only place its token appears.
 */
export function logInitLink(
  {
    db,
    logger,
    webAppUrl,
  }: { db: Database; logger: Logger; webAppUrl?: string },
  key: Buffer,
): void {
  let token
  try {
    token = initLinkToken(db, key)
  } catch (error) {
    // A locked database, say: serving matters more; the next start retries.
    logger.warn({ err: error }, 'passkey init link unavailable')
    return
  }
  if (!token) return
  const path = `/passkey#${token}`
  if (webAppUrl)
    logger.info(
      { link: `${new URL(webAppUrl).origin}${path}` },
      'no admin passkey yet; open this link to add one',
    )
  else
    logger.info(
      { path },
      'no admin passkey yet; set WEB_APP_URL, then open this path on it to add one',
    )
}
