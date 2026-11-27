import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { and, asc, eq, lt } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { newId } from '#db/id.ts'
import { passkeys, passkeyTokens, users } from '#db/schema.ts'
import { adminId } from '#users/users.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Challenges } from './challenges.ts'

/** How long a /passkey link stays good. */
export const TOKEN_TTL = 10 * 60 * 1000
/** What the browser waits for the authenticator. */
const CEREMONY_TIMEOUT = 2 * 60 * 1000
const RP_NAME = 'Midden'
export const NAME_MAX = 64

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

const fail = (status: 400 | 403 | 409, message: string) =>
  new HTTPException(status, { message })

/** Where the passkey ceremonies keep and check their state. */
export interface PasskeyStore {
  db: Database
  challenges: Challenges
}

/** A passkey is bound to the host name of the origin it was created on. */
export const rpIdOf = (origin: string) => new URL(origin).hostname

export interface PasskeyView {
  id: string
  name: string
  rp_id: string
  created_at: string
  last_used_at?: string
}

type Row = typeof passkeys.$inferSelect

const view = (row: Row): PasskeyView => ({
  id: row.id,
  name: row.name,
  rp_id: row.rpId,
  created_at: row.createdAt.toISOString(),
  ...(row.lastUsedAt ? { last_used_at: row.lastUsedAt.toISOString() } : {}),
})

const transportsOf = (row: Row): string[] => {
  try {
    const value: unknown = JSON.parse(row.transports)
    return Array.isArray(value)
      ? value.filter((t): t is string => typeof t === 'string')
      : []
  } catch {
    return []
  }
}

// --- /passkey links ----------------------------------------------------------

/**
 * One fresh link token per origin; links handed out before stop working.
 * Only the tokens' digests are kept.
 */
export function createPasskeyTokens(
  db: Database,
  origins: string[],
  now = Date.now(),
): { origin: string; token: string }[] {
  return db.transaction((tx) => {
    tx.delete(passkeyTokens).run()
    return origins.map((origin) => {
      const token = randomBytes(32).toString('base64url')
      tx.insert(passkeyTokens)
        .values({
          digest: digest(token),
          origin,
          expiresAt: new Date(now + TOKEN_TTL),
        })
        .run()
      return { origin, token }
    })
  })
}

/** The digest of a link token still good on this origin. */
function tokenDigest(
  db: Database,
  token: string,
  origin: string,
  now: number,
): string {
  const key = digest(token)
  const row = db
    .select()
    .from(passkeyTokens)
    .where(eq(passkeyTokens.digest, key))
    .get()
  if (!row || row.origin !== origin || row.expiresAt.getTime() <= now)
    throw fail(403, '链接已失效，请在 Telegram 中重新发送 /passkey')
  return key
}

// --- Registration --------------------------------------------------------------

/**
 * Whom a passkey is made for. Each user has their own WebAuthn user handle:
 * an authenticator keeps one passkey per RP ID and handle, so a shared one
 * would let a second user's passkey replace the admin's on a synced
 * keychain. The admin's is `midden-owner`, which every earlier passkey has.
 */
export interface PasskeyUser {
  /** The user's id; empty for an invite's user, who does not exist yet. */
  id: string
  /** Their handle, base64url. */
  webauthnId: string
  /** What an authenticator's account picker shows. */
  name: string
}

/** A user as a passkey is made for them. */
export function passkeyUser(db: Executor, id: string): PasskeyUser {
  const row = db
    .select({ id: users.id, webauthnId: users.webauthnId, name: users.name })
    .from(users)
    .where(eq(users.id, id))
    .get()
  if (!row) throw fail(403, '用户不存在')
  return row
}

/**
 * Options to create a passkey on this origin for `user`, the challenge
 * bound to `binding` (a /passkey link, a signed-in caller, an invite). It
 * excludes only that user's passkeys there: an authenticator holding the
 * admin's would otherwise refuse to make one for another user.
 */
export function creationOptions(
  { db, challenges }: PasskeyStore,
  origin: string,
  user: PasskeyUser,
  binding: string,
  now = Date.now(),
) {
  const rpID = rpIdOf(origin)
  const existing = user.id
    ? db
        .select()
        .from(passkeys)
        .where(and(eq(passkeys.rpId, rpID), eq(passkeys.userId, user.id)))
        .all()
    : []
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: Buffer.from(user.webauthnId, 'base64url'),
    userName: user.name,
    challenge: challenges.issue({ purpose: 'register', origin, binding }, now),
    timeout: CEREMONY_TIMEOUT,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: transportsOf(row),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  })
}

/**
 * Options to create a passkey on this origin: with a /passkey link's token
 * (one of the admin's), or signed in as `caller`, for `user`. The challenge
 * is bound to either.
 */
export function registrationOptions(
  store: PasskeyStore,
  origin: string,
  by: { token: string } | { caller: string; user: string },
  now = Date.now(),
) {
  const { db } = store
  const binding =
    'token' in by
      ? `link:${tokenDigest(db, by.token, origin, now)}`
      : `caller:${by.caller}`
  const user = passkeyUser(db, 'token' in by ? adminId(db) : by.user)
  return creationOptions(store, origin, user, binding, now)
}

/** A new passkey the authenticator made, checked against its challenge. */
export type NewCredential = NonNullable<
  Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']
>['credential']

/**
 * Check a registration against a challenge issued on this origin for
 * `binding`; the challenge is used up.
 */
export async function verifyCreation(
  { challenges }: PasskeyStore,
  origin: string,
  binding: string,
  response: RegistrationResponseJSON,
  now = Date.now(),
): Promise<NewCredential> {
  let taken = false
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) =>
        (taken = challenges.take(
          challenge,
          { purpose: 'register', origin, binding },
          now,
        )),
      expectedOrigin: origin,
      expectedRPID: rpIdOf(origin),
      requireUserPresence: true,
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('not verified')
    return result.registrationInfo.credential
  } catch {
    throw fail(400, taken ? '通行密钥验证失败' : '验证已过期，请重试')
  }
}

/** Keep a checked passkey of `user`'s, in the registration's transaction. */
export function keepPasskey(
  tx: Executor,
  input: {
    user: string
    origin: string
    name: string
    credential: NewCredential
  },
  now = Date.now(),
): PasskeyView {
  const { credential } = input
  if (
    tx
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialId, credential.id))
      .get()
  )
    throw fail(409, '这个通行密钥已经添加过了')
  const row = tx
    .insert(passkeys)
    .values({
      id: newId(),
      credentialId: credential.id,
      userId: input.user,
      rpId: rpIdOf(input.origin),
      name: input.name,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: JSON.stringify(credential.transports ?? []),
      createdAt: new Date(now),
    })
    .returning()
    .get()
  return view(row)
}

/**
 * Check a new passkey against its challenge and keep it. The challenge must
 * have come from the same link or caller; a link is then used up, and adds
 * one of the admin's.
 */
export async function register(
  store: PasskeyStore,
  origin: string,
  input: {
    response: RegistrationResponseJSON
    name: string
  } & ({ token: string } | { caller: string; user: string }),
  now = Date.now(),
): Promise<PasskeyView> {
  const linked = 'token' in input ? digest(input.token) : undefined
  const binding = 'token' in input ? `link:${linked}` : `caller:${input.caller}`
  const credential = await verifyCreation(
    store,
    origin,
    binding,
    input.response,
    now,
  )
  return store.db.transaction((tx) => {
    if (linked !== undefined) {
      // The link is good once: whoever registers first uses it up.
      const used = tx
        .delete(passkeyTokens)
        .where(
          and(
            eq(passkeyTokens.digest, linked),
            eq(passkeyTokens.origin, origin),
          ),
        )
        .returning()
        .get()
      if (!used || used.expiresAt.getTime() <= now)
        throw fail(403, '链接已失效，请在 Telegram 中重新发送 /passkey')
    }
    return keepPasskey(
      tx,
      {
        user: 'token' in input ? adminId(tx) : input.user,
        origin,
        name: input.name,
        credential,
      },
      now,
    )
  })
}

// --- Login ---------------------------------------------------------------------

/** Options to sign in on this origin with any passkey made for it. */
export function loginOptions(
  { challenges }: PasskeyStore,
  origin: string,
  now = Date.now(),
) {
  return generateAuthenticationOptions({
    rpID: rpIdOf(origin),
    challenge: challenges.issue({ purpose: 'login', origin }, now),
    timeout: CEREMONY_TIMEOUT,
    userVerification: 'required',
  })
}

/**
 * Check a sign-in; only a passkey made for this origin's RP ID counts.
 * Returns the user it signs in.
 */
export async function login(
  { db, challenges }: PasskeyStore,
  origin: string,
  response: AuthenticationResponseJSON,
  now = Date.now(),
): Promise<string> {
  const rpID = rpIdOf(origin)
  const found = db
    .select({ row: passkeys, revokedAt: users.revokedAt })
    .from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(and(eq(passkeys.credentialId, response.id), eq(passkeys.rpId, rpID)))
    .get()
  // A revoked user's passkeys are deleted with the revocation; this is a
  // second guard.
  if (!found || found.revokedAt) throw fail(400, '找不到这个通行密钥')
  const { row } = found
  let taken = false
  let info
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) =>
        (taken = challenges.take(challenge, { purpose: 'login', origin }, now)),
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.credentialId,
        publicKey: new Uint8Array(row.publicKey),
        counter: row.counter,
        transports: transportsOf(row),
      },
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('not verified')
    info = result.authenticationInfo
  } catch {
    throw fail(400, taken ? '通行密钥验证失败' : '验证已过期，请重试')
  }
  db.update(passkeys)
    .set({ counter: info.newCounter, lastUsedAt: new Date(now) })
    .where(eq(passkeys.id, row.id))
    .run()
  return row.userId
}

// --- Management ----------------------------------------------------------------

// Each user sees and changes their own; another's id is as good as none.
const own = (user: string, id: string) =>
  and(eq(passkeys.id, id), eq(passkeys.userId, user))

export function listPasskeys(db: Database, user: string): PasskeyView[] {
  return db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, user))
    .orderBy(asc(passkeys.createdAt), asc(passkeys.id))
    .all()
    .map(view)
}

export function renamePasskey(
  db: Database,
  user: string,
  id: string,
  name: string,
): PasskeyView | undefined {
  const row = db
    .update(passkeys)
    .set({ name })
    .where(own(user, id))
    .returning()
    .get()
  return row && view(row)
}

export function deletePasskey(
  db: Executor,
  user: string,
  id: string,
): PasskeyView | undefined {
  const row = db.delete(passkeys).where(own(user, id)).returning().get()
  return row && view(row)
}

/** Drop links nobody used in time. */
export function prunePasskeys(db: Database, now = Date.now()): void {
  db.delete(passkeyTokens)
    .where(lt(passkeyTokens.expiresAt, new Date(now)))
    .run()
}
