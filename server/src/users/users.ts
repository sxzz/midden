// Who signs in (docs/design/multi-user.md): the admin, who is the owner,
// and viewers, who only read. Sessions, passkeys and API tokens each
// belong to a user and go with them.
import { randomBytes } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { newId } from '#db/id.ts'
import {
  apiTokens,
  passkeys,
  users,
  webSessions,
  type UserRole,
} from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Database, Executor } from '#db/client.ts'

export const NAME_MAX = 32

/**
 * The admin's id. The `users` migration made them from the owner, and
 * `users_admin` keeps them the only one. The bot's /passkey links, the
 * Mini App and the CLI's tokens are theirs.
 */
export function adminId(db: Executor): string {
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .get()
  if (!row) throw new Error('no admin user; the users migration makes one')
  return row.id
}

/** A user as the app shows them. */
export interface UserView {
  id: string
  name: string
  role: UserRole
}

/** The user by id: who a session or token signed in. */
export function userView(db: Executor, id: string): UserView {
  const row = db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .get()
  if (!row) throw new AppError('not_found')
  return row
}

/** A name as stored: trimmed, 1 to 32 characters. */
export function checkName(raw: string): string {
  const name = raw.trim()
  if (!name || [...name].length > NAME_MAX || name.includes('\0'))
    throw new AppError('invalid_request', `名字不能为空，最多 ${NAME_MAX} 字`)
  return name
}

/** A new WebAuthn user handle: 32 random bytes, base64url. */
export const newHandle = () => randomBytes(32).toString('base64url')

/** Make a viewer, as an invite registers them; their id. */
export function createViewer(
  db: Executor,
  input: { name: string; webauthnId: string },
  now = Date.now(),
): string {
  const id = newId()
  db.insert(users)
    .values({
      id,
      name: checkName(input.name),
      role: 'viewer',
      webauthnId: input.webauthnId,
      createdAt: new Date(now),
    })
    .run()
  return id
}

/** A user in the admin's 用户 page: how many ways in they have, no activity. */
export interface UserListing extends UserView {
  created_at: string
  /** Revoked: shown as 已撤销, with no ways in left. */
  revoked_at: string | null
  passkeys: number
  /** Signed-in browsers not expired. */
  sessions: number
  tokens: number
}

/** Every user, the admin first, then by when they joined. */
export function listUsers(db: Database, now = Date.now()): UserListing[] {
  // How many of a user's rows a table has; drizzle would name the outer
  // id unqualified, as the inner table's.
  const count = (table: string, extra = '') =>
    sql<number>`(SELECT count(*) FROM ${sql.raw(table)} t
      WHERE t.user_id = "users"."id"${sql.raw(extra)})`.mapWith(Number)
  return db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
      revokedAt: users.revokedAt,
      passkeys: count('passkeys'),
      sessions: count('web_sessions', ` AND t.expires_at > ${Math.trunc(now)}`),
      tokens: count('api_tokens'),
    })
    .from(users)
    .orderBy(sql`${users.role} <> 'admin'`, asc(users.createdAt), asc(users.id))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      created_at: row.createdAt.toISOString(),
      revoked_at: row.revokedAt?.toISOString() ?? null,
      passkeys: row.passkeys,
      sessions: row.sessions,
      tokens: row.tokens,
    }))
}

/**
 * A user the admin may rename, revoke or delete: anyone but the admin. In
 * A no one changes role, and the admin cannot be removed.
 */
function other(db: Executor, id: string) {
  const row = db.select().from(users).where(eq(users.id, id)).get()
  if (!row) throw new AppError('not_found', '用户不存在')
  if (row.role === 'admin')
    throw new HTTPException(403, { message: '不能对管理员进行此操作' })
  return row
}

function listed(db: Database, id: string, now: number): UserListing {
  return listUsers(db, now).find((u) => u.id === id)!
}

export function renameUser(
  db: Database,
  id: string,
  name: string,
  now = Date.now(),
): UserListing {
  const checked = checkName(name)
  other(db, id)
  db.update(users).set({ name: checked }).where(eq(users.id, id)).run()
  return listed(db, id, now)
}

/**
 * Revoke a user: their passkeys, sessions and tokens (and the tokens'
 * usage) go at once, in one transaction; the row stays, marked revoked. A
 * revoked user can still be deleted, never restored: they are invited anew.
 */
export function revokeUser(
  db: Database,
  id: string,
  now = Date.now(),
): UserListing {
  db.transaction((tx) => {
    const row = other(tx, id)
    tx.delete(passkeys).where(eq(passkeys.userId, id)).run()
    tx.delete(webSessions).where(eq(webSessions.userId, id)).run()
    tx.delete(apiTokens).where(eq(apiTokens.userId, id)).run()
    if (!row.revokedAt)
      tx.update(users)
        .set({ revokedAt: new Date(now) })
        .where(eq(users.id, id))
        .run()
  })
  return listed(db, id, now)
}

/**
 * Delete a user: their sessions, passkeys and tokens go with the row
 * (foreign keys), and the invite they used forgets them. In A a viewer has
 * nothing else.
 */
export function deleteUser(db: Database, id: string): void {
  db.transaction((tx) => {
    other(tx, id)
    tx.delete(users).where(eq(users.id, id)).run()
  })
}
