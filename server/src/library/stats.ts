// `GET /v1/library/stats`: the archive as a whole, for the library's
// sidebar (全站统计): posts and accounts, how many posts carry images or
// videos, the space used, what was saved today and this week, and the
// captures and updates started today. Only counts of the whole archive,
// nobody's tags, notes or capture accounts, so a viewer gets them all, as
// the admin does. A handful of small reads (about 60 ms
// together on a copy of 60 000 collections), kept for a minute per read
// thread and time zone while the library does not change, so the sidebar
// adds next to nothing to a list's own reads.
import { sql } from 'drizzle-orm'
import { AppError } from '#errors.ts'
import { libraryVersion } from './folder-counts.ts'
import { storageUsed } from './read.ts'
import type { Executor } from '#db/client.ts'

export interface LibraryStats {
  posts: number
  accounts: number
  /** Posts with at least one image, or video. */
  with_images: number
  with_videos: number
  used_bytes: number
  /** Collections saved since local midnight, and since Monday. */
  saved_today: number
  saved_this_week: number
  /** Captures and updates started since local midnight. */
  captures_today: number
  updates_today: number
}

/** How long figures are kept; the sidebar is a summary, not a counter. */
export const STATS_TTL = 60_000
/** By database (a test opens several) and time zone. */
const kept = new WeakMap<
  object,
  Map<string, { at: number; version: number; stats: LibraryStats }>
>()

/** Local midnight today and on this week's Monday, in `zone`, as ms. */
function bounds(zone: string, now: number) {
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(zone)
    .startOfDay()
  const monday = today.subtract({ days: today.dayOfWeek - 1 }).startOfDay()
  return { today: today.epochMilliseconds, week: monday.epochMilliseconds }
}

function zoneOf(raw: string | undefined) {
  if (!raw) return 'UTC'
  try {
    return Temporal.Now.zonedDateTimeISO(raw).timeZoneId
  } catch {
    throw new AppError('invalid_request')
  }
}

export function libraryStats(
  db: Executor,
  input: { tz?: string },
  now = Date.now(),
): LibraryStats {
  const zone = zoneOf(input.tz)
  let zones = kept.get(db)
  if (!zones) kept.set(db, (zones = new Map()))
  // A save or a deletion counts at once; captures may wait the minute.
  const version = libraryVersion(db)
  const hit = zones.get(zone)
  if (hit && hit.version === version && now - hit.at < STATS_TTL)
    return hit.stats
  const { today, week } = bounds(zone, now)
  const kinds = db.all<{
    kind: string | null
    n: number
    img: number
    vid: number
  }>(
    sql`SELECT root_kind AS kind, count(*) AS n, sum(has_image) AS img,
      sum(has_video) AS vid FROM catalog GROUP BY root_kind`,
  )
  const profiles = kinds.filter((k) => k.kind?.endsWith('.profile'))
  const posts = kinds.filter((k) => !k.kind?.endsWith('.profile'))
  const sum = (rows: typeof kinds, key: 'n' | 'img' | 'vid') =>
    rows.reduce((n, row) => n + Number(row[key] ?? 0), 0)
  const count = (query: ReturnType<typeof sql>) =>
    Number(db.get<{ n: number }>(query)?.n ?? 0)
  const stats: LibraryStats = {
    posts: sum(posts, 'n'),
    accounts: sum(profiles, 'n'),
    with_images: sum(posts, 'img'),
    with_videos: sum(posts, 'vid'),
    used_bytes: storageUsed(db),
    saved_today: count(
      sql`SELECT count(*) AS n FROM library WHERE created_at >= ${today}`,
    ),
    saved_this_week: count(
      sql`SELECT count(*) AS n FROM library WHERE created_at >= ${week}`,
    ),
    captures_today: count(
      sql`SELECT count(*) AS n FROM captures WHERE created_at >= ${today}`,
    ),
    updates_today: count(
      sql`SELECT count(*) AS n FROM updates WHERE created_at >= ${today}`,
    ),
  }
  zones.set(zone, { at: now, version, stats })
  return stats
}
