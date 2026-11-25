import { eq } from 'drizzle-orm'
import { settings } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

export function readSetting(db: Database, key: string): string | undefined {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()?.value
}

export function writeSetting(db: Database, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

/**
 * Minutes without a Litestream heartbeat before the owner is told. Litestream
 * sends one every 5 minutes (litestream.yml); below that, a healthy backup
 * is reported too, which only makes sense when testing.
 */
export const HEARTBEAT_TIMEOUT = {
  key: 'litestream_timeout_minutes',
  default: 20,
  min: 1,
  max: 1440,
}

export function heartbeatTimeoutMinutes(db: Database): number {
  const stored = Number(readSetting(db, HEARTBEAT_TIMEOUT.key))
  return Number.isInteger(stored) && stored >= HEARTBEAT_TIMEOUT.min
    ? stored
    : HEARTBEAT_TIMEOUT.default
}

export function setHeartbeatTimeoutMinutes(
  db: Database,
  minutes: number,
): void {
  writeSetting(db, HEARTBEAT_TIMEOUT.key, String(minutes))
}
