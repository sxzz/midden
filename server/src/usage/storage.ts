import { alertThresholds, checkAlerts, type AlertThresholds } from './alerts.ts'
import {
  datasetLimits,
  fetchR2Usage,
  type AnalyticsOptions,
  type DatasetLimits,
} from './analytics.ts'
import {
  compositionDue,
  recordComposition,
  storedComposition,
  type Composition,
} from './composition.ts'
import { monthCost, type MonthCost } from './cost.ts'
import { localUsage, type LocalUsage } from './local.ts'
import {
  isoDay,
  r2Days,
  recordLocal,
  recordR2,
  snapshots,
  type SnapshotDay,
} from './snapshots.ts'
import type { Database } from '#db/client.ts'
import type { Logger } from '#log.ts'
import type {
  CompositionInput,
  CompositionOutput,
} from './composition-worker.ts'

/** The analytics, the local figures and the alerts are read this often. */
export const REFRESH_INTERVAL = 15 * 60_000
/** A refresh asked for on the page waits at least this long after the last. */
const MANUAL_REFRESH = 60_000

export interface StorageUsageOptions {
  db: Database
  dataDir: string
  databasePath: string
  mediaDir: string
  /** Without it there are no R2 figures. */
  cloudflare?: { accountId: string; apiToken: string }
  logger: Logger
  notify: (text: string) => void
  now?: () => number
  fetch?: typeof fetch
  apiBase?: string
  /** Tests replace the worker thread. */
  readComposition?: (input: CompositionInput) => Promise<CompositionOutput>
  /**
   * Whether the daily composition may be read now; it is put off while this
   * says no (the worker passes whether it is idle).
   */
  composeWhen?: () => boolean
}

/** One bucket now: its latest storage reading and the month's operations. */
export interface BucketUsage {
  name: string
  /** The newest day with a storage reading. */
  day: string | null
  bytes: number | null
  objects: number | null
  class_a: number
  class_b: number
}

export interface StorageReport {
  /** Null when the analytics are not configured or the last read failed. */
  r2: { fetched_at: string; buckets: BucketUsage[] } | null
  cost: MonthCost | null
  local: LocalUsage
  composition: Composition | null
  /** Every day recorded, oldest first. */
  history: SnapshotDay[]
  alerts: AlertThresholds
}

/**
 * 存储用量: R2 from Cloudflare's analytics, the server's own disk, the
 * database's composition, a daily history and the alerts on them. `tick`
 * runs from the server's minute timer and does its work every 15 minutes;
 * the composition is read once a day in a worker thread.
 */
export class StorageUsage {
  readonly #options: StorageUsageOptions
  readonly #now: () => number
  #limits: DatasetLimits | undefined
  #lastTick = -Infinity
  #lastAttempt = -Infinity
  /** When the analytics last answered; undefined after a failure. */
  #fetchedAt: number | undefined
  #refreshing: Promise<void> | undefined
  #composing: Promise<void> | undefined

  constructor(options: StorageUsageOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  get db(): Database {
    return this.#options.db
  }

  get #analytics(): AnalyticsOptions | undefined {
    const { cloudflare } = this.#options
    return cloudflare
      ? {
          accountId: cloudflare.accountId,
          token: cloudflare.apiToken,
          fetch: this.#options.fetch,
          apiBase: this.#options.apiBase,
        }
      : undefined
  }

  /** The datasets' limits; unknown after a failure, tried again next time. */
  async #readLimits(
    analytics: AnalyticsOptions,
  ): Promise<DatasetLimits | undefined> {
    try {
      return await datasetLimits(analytics)
    } catch (error) {
      this.#options.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'storage analytics limits unavailable; assuming 31 days',
      )
    }
  }

  /** Read the analytics into the history; a failure is logged and kept. */
  refreshR2(): Promise<void> {
    const analytics = this.#analytics
    if (!analytics) return Promise.resolve()
    this.#refreshing ??= (async () => {
      const now = this.#now()
      this.#lastAttempt = now
      try {
        this.#limits ??= await this.#readLimits(analytics)
        const usage = await fetchR2Usage(
          analytics,
          this.#limits ?? {
            maxRange: 31 * 86_400_000,
            retention: 31 * 86_400_000,
          },
          now,
        )
        recordR2(this.#options.db, usage.days, now)
        this.#fetchedAt = now
      } catch (error) {
        this.#fetchedAt = undefined
        this.#options.logger.warn(
          { reason: error instanceof Error ? error.message : String(error) },
          'storage analytics unavailable',
        )
      }
    })().finally(() => (this.#refreshing = undefined))
    return this.#refreshing
  }

  /** The month's R2 bill so far, from the history; null without R2. */
  #cost(history: readonly SnapshotDay[]): MonthCost | null {
    if (this.#fetchedAt === undefined) return null
    return monthCost(r2Days(history), isoDay(this.#now()).slice(0, 7))
  }

  /** Every 15 minutes: analytics, local figures, alerts. */
  async tick(): Promise<void> {
    const now = this.#now()
    // Not awaited: it takes long, in a worker thread, and logs its failures.
    if (
      compositionDue(this.#options.db, now) &&
      (this.#options.composeWhen?.() ?? true)
    )
      this.compose().catch(() => {})
    if (now - this.#lastTick < REFRESH_INTERVAL) return
    this.#lastTick = now
    await this.refreshR2()
    const { db } = this.#options
    const local = await this.#local()
    recordLocal(db, local, now)
    const month = isoDay(now).slice(0, 7)
    const cost = this.#cost(snapshots(db, `${month}-01`))
    checkAlerts(
      db,
      {
        month,
        freeBytes: local.disk.free_bytes,
        dbBytes: local.database.bytes,
        ...(cost
          ? {
              r2: {
                usd: cost.usd,
                classA: cost.class_a.used,
                classB: cost.class_b.used,
              },
            }
          : {}),
      },
      this.#options.notify,
    )
  }

  /** Read the database's composition, unless a reading is under way. */
  compose(): Promise<void> {
    const { db, databasePath, mediaDir, logger } = this.#options
    this.#composing ??= (async () => {
      try {
        const composition = await recordComposition(
          db,
          { databasePath, mediaDir },
          this.#now,
          this.#options.readComposition,
        )
        logger.info(
          { seconds: composition.seconds, bytes: composition.total_bytes },
          'database composition read',
        )
      } catch (error) {
        logger.warn({ err: error }, 'database composition failed')
      }
    })().finally(() => (this.#composing = undefined))
    return this.#composing
  }

  #local(): Promise<LocalUsage> {
    const { db, dataDir, databasePath } = this.#options
    return localUsage({ db, dataDir, databasePath })
  }

  /**
   * Everything the page shows. The analytics are read first when they never
   * were, or when `refresh` asks and the last read is a minute old.
   */
  async report(refresh = false): Promise<StorageReport> {
    const now = this.#now()
    if (
      this.#analytics &&
      (this.#lastAttempt === -Infinity ||
        (refresh && now - this.#lastAttempt >= MANUAL_REFRESH))
    )
      await this.refreshR2()
    const { db } = this.#options
    const history = snapshots(db)
    const cost = this.#cost(history)
    return {
      r2:
        this.#fetchedAt === undefined
          ? null
          : {
              fetched_at: new Date(this.#fetchedAt).toISOString(),
              buckets: buckets(history, isoDay(now).slice(0, 7)),
            },
      cost,
      local: await this.#local(),
      composition: storedComposition(db) ?? null,
      history,
      alerts: alertThresholds(db),
    }
  }
}

/** Each bucket's latest storage reading and its operations this month. */
function buckets(
  history: readonly SnapshotDay[],
  month: string,
): BucketUsage[] {
  const found = new Map<string, BucketUsage>()
  for (const { day, r2 } of history) {
    for (const [name, figures] of Object.entries(r2 ?? {})) {
      let bucket = found.get(name)
      if (!bucket) {
        bucket = {
          name,
          day: null,
          bytes: null,
          objects: null,
          class_a: 0,
          class_b: 0,
        }
        found.set(name, bucket)
      }
      if (figures.bytes !== null) {
        bucket.day = day
        bucket.bytes = figures.bytes
        bucket.objects = figures.objects
      }
      if (day.startsWith(`${month}-`)) {
        bucket.class_a += figures.class_a
        bucket.class_b += figures.class_b
      }
    }
  }
  return [...found.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}
