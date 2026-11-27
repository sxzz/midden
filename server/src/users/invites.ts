// Invites (邀请, docs/design/multi-user.md §4.1): one-time links the admin
// makes for a friend, good for 7 days and one registration, on
// WEB_APP_URL's origin only. Registering makes a viewer. They are looked
// up by the SHA-256 of the link's token, as /passkey links and API tokens
// are; while an invite is still good its token is also kept sealed, so the
// admin can show the link again.
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm'
import { seal, unseal } from '#crypto.ts'
import { newId } from '#db/id.ts'
import { invites } from '#db/schema.ts'
import { checkLabel, newHandle } from './users.ts'
import type { Database, Executor } from '#db/client.ts'

const DAY = 24 * 60 * 60 * 1000
/** How long an invite stays good. */
export const INVITE_TTL = 7 * DAY
/** Invites done with (expired, used, revoked) are kept this long, then pruned. */
const KEEP = 7 * DAY

export interface InviteView {
  id: string
  label: string
  created_at: string
  expires_at: string
}

/** An invite still good, and its token when it was kept. */
export interface PendingInvite extends InviteView {
  token: string | null
}

const digestOf = (token: string) =>
  createHash('sha256').update(token).digest('hex')

const newToken = () => randomBytes(32).toString('base64url')

/** What a sealed token is bound to: its row, so it opens nowhere else. */
const aadOf = (id: string) => `invite:${id}`

const sealToken = (key: Uint8Array, id: string, token: string) =>
  seal(key, aadOf(id), Buffer.from(token))

/**
 * The token a row keeps, if it opens with this key and is the one the row
 * is looked up by; null otherwise (none kept, or SECRET_KEY changed).
 */
function tokenOf(
  key: Uint8Array,
  row: typeof invites.$inferSelect,
): string | null {
  if (!row.sealedToken) return null
  try {
    const token = unseal(key, aadOf(row.id), row.sealedToken).toString()
    return digestOf(token) === row.digest ? token : null
  } catch {
    return null
  }
}

const view = (row: typeof invites.$inferSelect): InviteView => ({
  id: row.id,
  label: row.label,
  created_at: row.createdAt.toISOString(),
  expires_at: row.expiresAt.toISOString(),
})

/** Still good: not used, not revoked, not expired. */
const open = (now: number) =>
  and(
    isNull(invites.usedAt),
    isNull(invites.revokedAt),
    gt(invites.expiresAt, new Date(now)),
  )

/**
 * A new invite for whom `label` says, which becomes the admin's note on the
 * new user. `key` seals its token, which the link carries.
 */
export function createInvite(
  db: Database,
  key: Uint8Array,
  label: string,
  now = Date.now(),
): { invite: InviteView; token: string } {
  const id = newId()
  const token = newToken()
  const row = db
    .insert(invites)
    .values({
      id,
      digest: digestOf(token),
      sealedToken: sealToken(key, id, token),
      // The new user's handle, fixed now: the options and the registration
      // must agree on it, and the registration does not carry it.
      webauthnId: newHandle(),
      label: checkLabel(label),
      createdAt: new Date(now),
      expiresAt: new Date(now + INVITE_TTL),
    })
    .returning()
    .get()
  return { invite: view(row), token }
}

/**
 * The same invite with a new token and 7 days from now: the old link stops
 * working at once. Undefined when it is no longer good.
 */
export function regenerateInvite(
  db: Database,
  key: Uint8Array,
  id: string,
  now = Date.now(),
): { invite: InviteView; token: string } | undefined {
  const token = newToken()
  const row = db
    .update(invites)
    .set({
      digest: digestOf(token),
      sealedToken: sealToken(key, id, token),
      expiresAt: new Date(now + INVITE_TTL),
    })
    .where(and(eq(invites.id, id), open(now)))
    .returning()
    .get()
  return row && { invite: view(row), token }
}

/** The invites still good, oldest first, with their tokens where kept. */
export function listInvites(
  db: Database,
  key: Uint8Array,
  now = Date.now(),
): PendingInvite[] {
  return db
    .select()
    .from(invites)
    .where(open(now))
    .orderBy(asc(invites.createdAt), asc(invites.id))
    .all()
    .map((row) => ({ ...view(row), token: tokenOf(key, row) }))
}

/** Revoke an invite still good; false when there is none such. */
export function revokeInvite(
  db: Database,
  id: string,
  now = Date.now(),
): boolean {
  const row = db
    .update(invites)
    .set({ revokedAt: new Date(now), sealedToken: null })
    .where(and(eq(invites.id, id), open(now)))
    .returning()
    .get()
  return !!row
}

/** What registering with an invite needs of it. */
export interface OpenInvite {
  digest: string
  webauthnId: string
  label: string
}

/** The invite a token names, if it is still good. */
export function openInvite(
  db: Executor,
  token: string,
  now = Date.now(),
): OpenInvite | undefined {
  const row = db
    .select()
    .from(invites)
    .where(and(eq(invites.digest, digestOf(token)), open(now)))
    .get()
  return (
    row && {
      digest: row.digest,
      webauthnId: row.webauthnId,
      label: row.label,
    }
  )
}

/**
 * Use the invite up for `user`, in the registration's transaction: false
 * when it is no longer good, so of two registrations at once only one
 * gets it. Its token is no longer kept.
 */
export function useInvite(
  tx: Executor,
  digest: string,
  user: string,
  now = Date.now(),
): boolean {
  const row = tx
    .update(invites)
    .set({ usedAt: new Date(now), usedBy: user, sealedToken: null })
    .where(and(eq(invites.digest, digest), open(now)))
    .returning({ id: invites.id })
    .get()
  return !!row
}

/** Drop invites that expired, were used or were revoked a week ago. */
export function pruneInvites(db: Database, now = Date.now()): void {
  const before = new Date(now - KEEP)
  db.delete(invites)
    .where(
      or(
        lt(invites.expiresAt, before),
        lt(invites.usedAt, before),
        lt(invites.revokedAt, before),
      ),
    )
    .run()
}
