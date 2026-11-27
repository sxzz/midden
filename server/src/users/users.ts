// Who signs in (docs/design/multi-user.md): the admin, who is the owner,
// and viewers, who only read. Sessions, passkeys and API tokens each
// belong to a user.
import { eq } from 'drizzle-orm'
import { users, type UserRole } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Executor } from '#db/client.ts'

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
