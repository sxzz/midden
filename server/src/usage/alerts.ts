import { readSetting, writeSetting } from '#settings.ts'
import { R2_PRICES } from './cost.ts'
import type { Database } from '#db/client.ts'

const GiB = 2 ** 30

/**
 * Storage alert thresholds, admin settings in the `settings` table. Local
 * sizes are in GB of 2^30 bytes, as the web app shows sizes.
 */
export const STORAGE_ALERTS = {
  cost_usd: {
    key: 'storage_alert_cost_usd',
    default: 5,
    min: 0.01,
    max: 10_000,
  },
  free_disk_gb: {
    key: 'storage_alert_free_disk_gb',
    default: 10,
    min: 1,
    max: 100_000,
  },
  db_gb: { key: 'storage_alert_db_gb', default: 5, min: 1, max: 100_000 },
  ops_percent: {
    key: 'storage_alert_ops_percent',
    default: 80,
    min: 1,
    max: 100,
  },
} as const

export type AlertName = keyof typeof STORAGE_ALERTS
export type AlertThresholds = Record<AlertName, number>

export function alertThresholds(db: Database): AlertThresholds {
  const read = (name: AlertName) => {
    const { key, min, max, default: fallback } = STORAGE_ALERTS[name]
    const stored = Number(readSetting(db, key))
    return Number.isFinite(stored) && stored >= min && stored <= max
      ? stored
      : fallback
  }
  return {
    cost_usd: read('cost_usd'),
    free_disk_gb: read('free_disk_gb'),
    db_gb: read('db_gb'),
    ops_percent: read('ops_percent'),
  }
}

export function setAlertThresholds(
  db: Database,
  values: Partial<AlertThresholds>,
): void {
  for (const [name, value] of Object.entries(values))
    if (value !== undefined)
      writeSetting(db, STORAGE_ALERTS[name as AlertName].key, String(value))
}

/** What the alerts look at; R2's part is absent without the analytics. */
export interface AlertFacts {
  /** YYYY-MM, UTC: the month the R2 figures are for. */
  month: string
  freeBytes: number
  dbBytes: number
  r2?: { usd: number; classA: number; classB: number }
}

/** Which alerts are raised, kept across restarts so none repeats. */
const STATE_KEY = 'storage_alert_state'
type Condition = 'cost' | 'disk' | 'database' | 'class_a' | 'class_b'
type AlertState = Partial<Record<Condition, { month?: string }>>

const usd = (value: number) => `$${value.toFixed(2)}`
const threshold = (value: number) =>
  Number.isInteger(value) ? `$${value}` : usd(value)
const gb = (bytes: number) => `${(bytes / GiB).toFixed(1)} GB`
const count = (value: number) => value.toLocaleString('en-US')
const tenThousands = (value: number) => `${value / 10_000} 万次`

function readState(db: Database): AlertState {
  try {
    return JSON.parse(readSetting(db, STATE_KEY) ?? '{}') as AlertState
  } catch {
    return {}
  }
}

/**
 * Tell the owner when a figure crosses its threshold, and once more when it
 * is back, like the Litestream heartbeat: never again while it holds. The
 * monthly R2 figures start over each month, so a raised R2 alert ends
 * silently when the month does. Without R2 figures their alerts stay as
 * they were.
 */
export function checkAlerts(
  db: Database,
  facts: AlertFacts,
  notify: (text: string) => void,
): void {
  const limits = alertThresholds(db)
  const state = readState(db)
  const before = JSON.stringify(state)
  const ops = limits.ops_percent / 100
  const conditions: {
    name: Condition
    monthly: boolean
    on?: boolean
    raised: () => string
    cleared: () => string
  }[] = [
    {
      name: 'disk',
      monthly: false,
      on: facts.freeBytes < limits.free_disk_gb * GiB,
      raised: () =>
        `存储用量：数据盘可用 ${gb(facts.freeBytes)}，低于 ${limits.free_disk_gb} GB`,
      cleared: () =>
        `存储用量：数据盘可用 ${gb(facts.freeBytes)}，不再低于 ${limits.free_disk_gb} GB`,
    },
    {
      name: 'database',
      monthly: false,
      on: facts.dbBytes > limits.db_gb * GiB,
      raised: () =>
        `存储用量：数据库文件 ${gb(facts.dbBytes)}，超过 ${limits.db_gb} GB`,
      cleared: () =>
        `存储用量：数据库文件 ${gb(facts.dbBytes)}，不再超过 ${limits.db_gb} GB`,
    },
  ]
  const r2 = facts.r2
  if (r2)
    conditions.push(
      {
        name: 'cost',
        monthly: true,
        on: r2.usd > limits.cost_usd,
        raised: () =>
          `存储用量：本月 R2 费用 ${usd(r2.usd)}，超过 ${threshold(limits.cost_usd)}`,
        cleared: () =>
          `存储用量：本月 R2 费用 ${usd(r2.usd)}，不再超过 ${threshold(limits.cost_usd)}`,
      },
      ...(
        [
          ['class_a', 'Class A', r2.classA, R2_PRICES.classA.free],
          ['class_b', 'Class B', r2.classB, R2_PRICES.classB.free],
        ] as const
      ).map(([name, label, used, free]) => ({
        name,
        monthly: true,
        on: used > free * ops,
        raised: () =>
          `存储用量：本月 R2 ${label} 操作 ${count(used)} 次，超过免费额度 ${tenThousands(free)}的 ${limits.ops_percent}%`,
        cleared: () =>
          `存储用量：本月 R2 ${label} 操作 ${count(used)} 次，不再超过免费额度 ${tenThousands(free)}的 ${limits.ops_percent}%`,
      })),
    )

  for (const condition of conditions) {
    let raised = state[condition.name]
    if (raised && condition.monthly && raised.month !== facts.month) {
      delete state[condition.name]
      raised = undefined
    }
    if (condition.on && !raised) {
      state[condition.name] = condition.monthly ? { month: facts.month } : {}
      notify(condition.raised())
    } else if (!condition.on && raised) {
      delete state[condition.name]
      notify(condition.cleared())
    }
  }
  if (JSON.stringify(state) !== before)
    writeSetting(db, STATE_KEY, JSON.stringify(state))
}
