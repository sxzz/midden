import { CLOUDFLARE_API, envelopeErrors } from '#cloudflare.ts'
import { operationClass } from './cost.ts'
import type { BucketDay } from '#db/schema.ts'

const TIMEOUT = 30_000
const DAY = 86_400_000
/**
 * Cloudflare's GraphQL Analytics API answers at most 31 days per query
 * (https://developers.cloudflare.com/r2/platform/metrics-analytics/); the
 * account's own limits, when it reports them, narrow this further.
 */
const MAX_RANGE = 31 * DAY
/** Rows per query. A month of two buckets is a few hundred. */
const PAGE = 10_000

export interface AnalyticsOptions {
  accountId: string
  token: string
  fetch?: typeof fetch
  /** Cloudflare's API base; the GraphQL endpoint is `<base>/graphql`. */
  apiBase?: string
}

/** What the datasets allow this account to ask for, in milliseconds. */
export interface DatasetLimits {
  /** The widest range one query may cover. */
  maxRange: number
  /** How far back data is kept. */
  retention: number
}

/** Every bucket's figures by UTC day, as the analytics give them. */
export interface R2Usage {
  /** day (YYYY-MM-DD) → bucket → figures. */
  days: Map<string, Record<string, BucketDay>>
  /** The first whole day the query covered. */
  from: string
}

interface GraphQLBody<T> {
  data?: T | null
  errors?: { code?: number; message?: string }[]
}

/** A failed analytics request; the message never carries the token. */
export class AnalyticsError extends Error {
  override name = 'AnalyticsError'
}

async function query<T>(
  options: AnalyticsOptions,
  text: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const send = options.fetch ?? fetch
  let response: Response
  try {
    response = await send(`${options.apiBase ?? CLOUDFLARE_API}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (error) {
    throw new AnalyticsError(`analytics request failed: ${String(error)}`, {
      cause: error,
    })
  }
  const body = (await response.json().catch(() => undefined)) as
    GraphQLBody<T> | undefined
  // GraphQL errors and the REST envelope's share a shape.
  const errors = envelopeErrors(body ?? undefined)
  if (!response.ok || !body?.data || errors)
    throw new AnalyticsError(
      `analytics query failed: ${response.status}${errors ? ` ${errors}` : ''}`,
    )
  return body.data
}

const LIMITS_QUERY = `query R2Limits($accountTag: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        r2StorageAdaptiveGroups { maxDuration notOlderThan }
        r2OperationsAdaptiveGroups { maxDuration notOlderThan }
      }
    }
  }
}`

interface Limit {
  maxDuration?: number | null
  notOlderThan?: number | null
}

/**
 * The narrower of the two datasets' range and retention, in seconds as the
 * API reports them. Unknown values fall back to the documented 31 days.
 */
export async function datasetLimits(
  options: AnalyticsOptions,
): Promise<DatasetLimits> {
  const data = await query<{
    viewer?: {
      accounts?: {
        settings?: Record<string, Limit | null> | null
      }[]
    }
  }>(options, LIMITS_QUERY, { accountTag: options.accountId })
  const settings = data.viewer?.accounts?.[0]?.settings ?? {}
  const limits = Object.values(settings).filter((s) => s != null)
  const seconds = (pick: (limit: Limit) => number | null | undefined) =>
    Math.min(
      ...limits.map((limit) => {
        const value = pick(limit)
        return typeof value === 'number' && value > 0 ? value * 1000 : MAX_RANGE
      }),
      MAX_RANGE,
    )
  return {
    maxRange: seconds((limit) => limit.maxDuration),
    retention: seconds((limit) => limit.notOlderThan),
  }
}

const USAGE_QUERY = `query R2Usage($accountTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      storage: r2StorageAdaptiveGroups(
        limit: ${PAGE}
        filter: { datetime_geq: $since, datetime_leq: $until }
      ) {
        max { objectCount payloadSize metadataSize }
        dimensions { date bucketName }
      }
      operations: r2OperationsAdaptiveGroups(
        limit: ${PAGE}
        filter: { datetime_geq: $since, datetime_leq: $until }
      ) {
        sum { requests }
        dimensions { date bucketName actionType }
      }
    }
  }
}`

interface StorageRow {
  max?: {
    objectCount?: number
    payloadSize?: number
    metadataSize?: number
  }
  dimensions?: { date?: string; bucketName?: string }
}
interface OperationRow {
  sum?: { requests?: number }
  dimensions?: { date?: string; bucketName?: string; actionType?: string }
}

const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10)
const midnight = (at: number) => Math.floor(at / DAY) * DAY

/**
 * Every bucket's storage (the day's peak) and operations (by class) for
 * each whole UTC day from as far back as one query and the retention allow,
 * up to `now`: today so far included. Storage is grouped by day, taking the
 * largest reading, which is how R2 bills it; operations are summed.
 */
export async function fetchR2Usage(
  options: AnalyticsOptions,
  limits: DatasetLimits,
  now: number,
): Promise<R2Usage> {
  // A minute's margin keeps the range inside the limits by the time the
  // query arrives; the first day is then whole only from its midnight.
  const earliest = now - Math.min(limits.maxRange, limits.retention) + 60_000
  const since =
    midnight(earliest) < earliest ? midnight(earliest) + DAY : earliest
  const data = await query<{
    viewer?: {
      accounts?: { storage?: StorageRow[]; operations?: OperationRow[] }[]
    }
  }>(options, USAGE_QUERY, {
    accountTag: options.accountId,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
  })
  const account = data.viewer?.accounts?.[0]
  const storage = account?.storage ?? []
  const operations = account?.operations ?? []
  if (storage.length >= PAGE || operations.length >= PAGE)
    throw new AnalyticsError('analytics query hit the row limit')

  const days = new Map<string, Record<string, BucketDay>>()
  const bucketDay = (day: string, bucket: string) => {
    let buckets = days.get(day)
    if (!buckets) days.set(day, (buckets = {}))
    return (buckets[bucket] ??= {
      bytes: null,
      objects: null,
      class_a: 0,
      class_b: 0,
    })
  }
  for (const row of storage) {
    const { date, bucketName } = row.dimensions ?? {}
    if (!date || !bucketName) continue
    const entry = bucketDay(date, bucketName)
    entry.bytes = Math.max(
      entry.bytes ?? 0,
      (row.max?.payloadSize ?? 0) + (row.max?.metadataSize ?? 0),
    )
    entry.objects = Math.max(entry.objects ?? 0, row.max?.objectCount ?? 0)
  }
  for (const row of operations) {
    const { date, bucketName, actionType } = row.dimensions ?? {}
    if (!date || !bucketName || !actionType) continue
    const kind = operationClass(actionType)
    if (kind === 'free') continue
    const entry = bucketDay(date, bucketName)
    if (kind === 'a') entry.class_a += row.sum?.requests ?? 0
    else entry.class_b += row.sum?.requests ?? 0
  }
  return { days, from: isoDay(since) }
}
