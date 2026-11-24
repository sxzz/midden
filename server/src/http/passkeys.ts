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
import { and, asc, count, eq, lt } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { newId } from '#db/id.ts'
import { passkeyChallenges, passkeys, passkeyTokens } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

/** How long a /passkey link stays good. */
export const TOKEN_TTL = 10 * 60 * 1000
const CHALLENGE_TTL = 5 * 60 * 1000
/** What the browser waits for the authenticator. */
const CEREMONY_TIMEOUT = 2 * 60 * 1000
/** Unanswered challenges at once; past this, new ones are refused. */
const MAX_CHALLENGES = 500
const RP_NAME = 'Midden'
// One user owns every passkey, so they all carry the same user handle; an
// authenticator then keeps one passkey per domain for this app.
const USER_ID = new TextEncoder().encode('midden-owner')
export const NAME_MAX = 64

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

const fail = (status: 400 | 403 | 409 | 429, message: string) =>
  new HTTPException(status, { message })

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

// --- Challenges ----------------------------------------------------------------

function issueChallenge(
  db: Database,
  values: Omit<typeof passkeyChallenges.$inferInsert, 'digest' | 'expiresAt'>,
  now: number,
): Uint8Array<ArrayBuffer> {
  db.delete(passkeyChallenges)
    .where(lt(passkeyChallenges.expiresAt, new Date(now)))
    .run()
  const pending = db.select({ n: count() }).from(passkeyChallenges).get()!.n
  if (pending >= MAX_CHALLENGES) throw fail(429, '请求过于频繁，请稍后重试')
  const challenge = new Uint8Array(randomBytes(32))
  db.insert(passkeyChallenges)
    .values({
      ...values,
      digest: digest(Buffer.from(challenge).toString('base64url')),
      expiresAt: new Date(now + CHALLENGE_TTL),
    })
    .run()
  return challenge
}

/**
 * Take a challenge out for good: it answers once, whether or not the
 * response it came with turns out valid.
 */
function takeChallenge(
  db: Database,
  challenge: string,
  expected: { kind: 'login' | 'register'; origin: string },
  now: number,
) {
  const row = db
    .delete(passkeyChallenges)
    .where(eq(passkeyChallenges.digest, digest(challenge)))
    .returning()
    .get()
  if (
    !row ||
    row.kind !== expected.kind ||
    row.origin !== expected.origin ||
    row.expiresAt.getTime() <= now
  )
    return
  return row
}

// --- Registration --------------------------------------------------------------

/**
 * Options to create a passkey on this origin: signed in, or with a /passkey
 * link's token.
 */
export function registrationOptions(
  db: Database,
  origin: string,
  token: string | undefined,
  now = Date.now(),
) {
  const linked =
    token === undefined ? undefined : tokenDigest(db, token, origin, now)
  const rpID = rpIdOf(origin)
  const existing = db
    .select()
    .from(passkeys)
    .where(eq(passkeys.rpId, rpID))
    .all()
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: USER_ID,
    userName: RP_NAME,
    challenge: issueChallenge(
      db,
      { kind: 'register', origin, tokenDigest: linked },
      now,
    ),
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
 * Check a new passkey against its challenge and keep it. With a link's
 * token, the challenge must have come from that link, which is then used up.
 */
export async function register(
  db: Database,
  origin: string,
  input: {
    response: RegistrationResponseJSON
    name: string
    token?: string
  },
  now = Date.now(),
): Promise<PasskeyView> {
  const rpID = rpIdOf(origin)
  let challengeRow: ReturnType<typeof takeChallenge>
  let info
  try {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (challenge) =>
        !!(challengeRow = takeChallenge(
          db,
          challenge,
          { kind: 'register', origin },
          now,
        )),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('not verified')
    info = result.registrationInfo
  } catch {
    throw fail(400, challengeRow ? '通行密钥验证失败' : '验证已过期，请重试')
  }
  const linked = input.token === undefined ? undefined : digest(input.token)
  if ((challengeRow!.tokenDigest ?? undefined) !== linked)
    throw fail(403, '链接已失效，请在 Telegram 中重新发送 /passkey')
  const { credential } = info
  return db.transaction((tx) => {
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
        rpId: rpID,
        name: input.name,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: JSON.stringify(credential.transports ?? []),
        createdAt: new Date(now),
      })
      .returning()
      .get()
    return view(row)
  })
}

// --- Login ---------------------------------------------------------------------

/** Options to sign in on this origin with any passkey made for it. */
export function loginOptions(db: Database, origin: string, now = Date.now()) {
  return generateAuthenticationOptions({
    rpID: rpIdOf(origin),
    challenge: issueChallenge(db, { kind: 'login', origin }, now),
    timeout: CEREMONY_TIMEOUT,
    userVerification: 'required',
  })
}

/** Check a sign-in; only a passkey made for this origin's RP ID counts. */
export async function login(
  db: Database,
  origin: string,
  response: AuthenticationResponseJSON,
  now = Date.now(),
): Promise<void> {
  const rpID = rpIdOf(origin)
  const row = db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.credentialId, response.id), eq(passkeys.rpId, rpID)))
    .get()
  if (!row) throw fail(400, '找不到这个通行密钥')
  let taken = false
  let info
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) =>
        (taken = !!takeChallenge(
          db,
          challenge,
          { kind: 'login', origin },
          now,
        )),
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
}

// --- Management ----------------------------------------------------------------

export function listPasskeys(db: Database): PasskeyView[] {
  return db
    .select()
    .from(passkeys)
    .orderBy(asc(passkeys.createdAt), asc(passkeys.id))
    .all()
    .map(view)
}

export function renamePasskey(
  db: Database,
  id: string,
  name: string,
): PasskeyView | undefined {
  const row = db
    .update(passkeys)
    .set({ name })
    .where(eq(passkeys.id, id))
    .returning()
    .get()
  return row && view(row)
}

export function deletePasskey(
  db: Database,
  id: string,
): PasskeyView | undefined {
  const row = db.delete(passkeys).where(eq(passkeys.id, id)).returning().get()
  return row && view(row)
}

/** Drop challenges and links nobody answered in time. */
export function prunePasskeys(db: Database, now = Date.now()): void {
  db.delete(passkeyChallenges)
    .where(lt(passkeyChallenges.expiresAt, new Date(now)))
    .run()
  db.delete(passkeyTokens)
    .where(lt(passkeyTokens.expiresAt, new Date(now)))
    .run()
}
