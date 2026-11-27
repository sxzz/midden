import { randomBytes } from 'node:crypto'
import { newId } from '#db/id.ts'
import { users } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

/** A viewer, made straight in the database; their id. */
export function addViewer(db: Database, name = '朋友'): string {
  const id = newId()
  db.insert(users)
    .values({
      id,
      name,
      role: 'viewer',
      webauthnId: randomBytes(32).toString('base64url'),
    })
    .run()
  return id
}
