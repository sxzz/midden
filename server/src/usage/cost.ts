/**
 * R2 Standard prices and monthly free tier, from
 * https://developers.cloudflare.com/r2/pricing/ (read 2026-11-26). Egress is
 * free. A GB is 10^9 bytes, as in Cloudflare's R2 pricing calculator; the
 * pricing page does not say.
 */
export const R2_PRICES = {
  storage: { usdPerUnit: 0.015, free: 10 },
  classA: { usdPerMillion: 4.5, free: 1_000_000 },
  classB: { usdPerMillion: 0.36, free: 10_000_000 },
  bytesPerGB: 1e9,
} as const

// Operation classes as the pricing page lists them, by the `actionType` the
// analytics report.
const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
])
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
])
const FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'])
// Names the page does not list follow its pattern: reads and heads are
// Class B, deletes and aborts are free, anything else that changes or lists
// is Class A, so nothing billable goes uncounted.
const B_PATTERN = /^(?:Get|Head)/
const FREE_PATTERN = /^(?:Delete|Abort)/

export type OperationClass = 'a' | 'b' | 'free'

export function operationClass(actionType: string): OperationClass {
  if (CLASS_A.has(actionType)) return 'a'
  if (CLASS_B.has(actionType)) return 'b'
  if (FREE.has(actionType)) return 'free'
  if (B_PATTERN.test(actionType)) return 'b'
  if (FREE_PATTERN.test(actionType)) return 'free'
  return 'a'
}

/** One item of the bill: how much was used, the free part, and the rest. */
export interface CostItem {
  used: number
  free: number
  billable: number
  usd: number
}

export interface MonthCost {
  /** YYYY-MM, UTC. */
  month: string
  /** Days of the month with R2 figures. */
  days: number
  /** In GB-months. */
  storage: CostItem
  class_a: CostItem
  class_b: CostItem
  usd: number
}

/** A day's R2 figures across every bucket. */
export interface R2Day {
  /** YYYY-MM-DD, UTC. */
  day: string
  /** Peak storage that day, in bytes. */
  bytes: number
  classA: number
  classB: number
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, m, 0)).getUTCDate()
}

function item(used: number, free: number, usdPerUnit: number): CostItem {
  const billable = Math.max(0, used - free)
  return { used, free, billable, usd: billable * usdPerUnit }
}

/**
 * The month's R2 bill so far. Storage is billed in GB-months, the average
 * of each day's peak over the month: a day adds its peak divided by the
 * month's length, so the amount grows through the month and reaches the
 * average on its last day. The free tier is the month's, taken off what has
 * accrued. Days of other months are ignored.
 */
export function monthCost(days: readonly R2Day[], month: string): MonthCost {
  const own = days.filter((d) => d.day.startsWith(`${month}-`))
  const length = daysInMonth(month)
  const gbMonths =
    own.reduce((sum, d) => sum + d.bytes, 0) / R2_PRICES.bytesPerGB / length
  const classA = own.reduce((sum, d) => sum + d.classA, 0)
  const classB = own.reduce((sum, d) => sum + d.classB, 0)
  const storage = item(
    gbMonths,
    R2_PRICES.storage.free,
    R2_PRICES.storage.usdPerUnit,
  )
  const a = item(
    classA,
    R2_PRICES.classA.free,
    R2_PRICES.classA.usdPerMillion / 1e6,
  )
  const b = item(
    classB,
    R2_PRICES.classB.free,
    R2_PRICES.classB.usdPerMillion / 1e6,
  )
  return {
    month,
    days: own.length,
    storage,
    class_a: a,
    class_b: b,
    usd: storage.usd + a.usd + b.usd,
  }
}
