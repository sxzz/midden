import { Hono } from 'hono'
import * as v from 'valibot'
import {
  alertThresholds,
  setAlertThresholds,
  STORAGE_ALERTS,
  type AlertName,
} from '#usage/alerts.ts'
import { inline } from './offload.ts'
import { json, query, type Env } from './validate.ts'
import type { StorageUsage } from '#usage/storage.ts'

const threshold = (name: AlertName) =>
  v.optional(
    v.pipe(
      v.number(),
      v.minValue(STORAGE_ALERTS[name].min),
      v.maxValue(STORAGE_ALERTS[name].max),
    ),
  )

/** 设置 → 管理员面板 → 存储用量. */
export function storageRoutes(storage: StorageUsage | undefined) {
  return (
    new Hono<Env>()
      // Analytics fetched and kept in this process, read here.
      .get(
        '/',
        inline,
        query(v.object({ refresh: v.optional(v.literal('1')) })),
        async (c) => {
          if (!storage) return c.json({ error: '服务器未提供存储用量' }, 404)
          return c.json(await storage.report(!!c.req.valid('query').refresh))
        },
      )
      .put(
        '/alerts',
        json(
          v.strictObject({
            cost_usd: threshold('cost_usd'),
            free_disk_gb: threshold('free_disk_gb'),
            db_gb: threshold('db_gb'),
            ops_percent: threshold('ops_percent'),
          }),
        ),
        (c) => {
          if (!storage) return c.json({ error: '服务器未提供存储用量' }, 404)
          const { db } = storage
          setAlertThresholds(db, c.req.valid('json'))
          return c.json(alertThresholds(db))
        },
      )
  )
}
