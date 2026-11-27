import { createToken, type Permission } from '#tokens/tokens.ts'
import { adminId } from '#users/users.ts'
import type { Database } from '#db/client.ts'

/** A new token's secret: read and write unless asked otherwise. */
export function tokenSecret(
  db: Database,
  permission: Permission = 'rw',
  label = 'test',
): string {
  return createToken(db, { user: adminId(db), label, permission }).secret
}
