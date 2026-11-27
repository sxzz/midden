// Invites (邀请, docs/design/multi-user.md §4.1): one-time links the admin
// makes for a friend, good for 7 days and one registration, on
// WEB_APP_URL's origin only. Registering makes a viewer. Only the SHA-256
// of the link's token is kept, as for /passkey links and API tokens.
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { invites } from '#db/schema.ts'
import { checkName, newHandle } from './users.ts'
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

const digestOf = (token: string) =>
  createHash('sha256').update(token).digest('hex')

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
 * A new invite for whom `label` says, which is also the new user's name
 * until they give their own. The token is shown this once, in the link.
 */
export function createInvite(
  db: Database,
  label: string,
  now = Date.now(),
): { invite: InviteView; token: string } {
  const token = randomBytes(32).toString('base64url')
  const row = db
    .insert(invites)
    .values({
      id: newId(),
      digest: digestOf(token),
      // The new user's handle, fixed now: the options and the registration
      // must agree on it, and the registration does not carry it.
      webauthnId: newHandle(),
      label: checkName(label),
      createdAt: new Date(now),
      expiresAt: new Date(now + INVITE_TTL),
    })
    .returning()
    .get()
  return { invite: view(row), token }
}

/** The invites still good, oldest first. */
export function listInvites(db: Database, now = Date.now()): InviteView[] {
  return db
    .select()
    .from(invites)
    .where(open(now))
    .orderBy(asc(invites.createdAt), asc(invites.id))
    .all()
    .map(view)
}

/** Revoke an invite still good; false when there is none such. */
export function revokeInvite(
  db: Database,
  id: string,
  now = Date.now(),
): boolean {
  const row = db
    .update(invites)
    .set({ revokedAt: new Date(now) })
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
 * gets it.
 */
export function useInvite(
  tx: Executor,
  digest: string,
  user: string,
  now = Date.now(),
): boolean {
  const row = tx
    .update(invites)
    .set({ usedAt: new Date(now), usedBy: user })
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
