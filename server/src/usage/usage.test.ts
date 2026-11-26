import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { openDatabase, type Database } from '#db/client.ts'
import { createApi } from '#http/app.ts'
import { testContext } from '#testing/context.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { checkAlerts, setAlertThresholds, type AlertFacts } from './alerts.ts'
import { datasetLimits, fetchR2Usage } from './analytics.ts'
import { compositionDue, storedComposition } from './composition.ts'
import { monthCost, operationClass, type R2Day } from './cost.ts'
import { snapshots } from './snapshots.ts'
import { StorageUsage } from './storage.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const GB = 1e9
const GiB = 2 ** 30
const DAY = 86_400_000
const ACCOUNT = 'a'.repeat(32)
const at = (iso: string) => Date.parse(iso)

describe('the month’s R2 bill', () => {
  const day = (d: string, bytes: number, classA = 0, classB = 0): R2Day => ({
    day: d,
    bytes,
    classA,
    classB,
  })

  test('within the free tier it costs nothing', () => {
    const cost = monthCost(
      [day('2026-11-01', 5 * GB, 900_000, 9_000_000)],
      '2026-11',
    )
    expect(cost.storage).toEqual({
      used: 5 / 30,
      free: 10,
      billable: 0,
      usd: 0,
    })
    expect(cost.class_a).toMatchObject({ used: 900_000, billable: 0, usd: 0 })
    expect(cost.class_b).toMatchObject({ used: 9_000_000, usd: 0 })
    expect(cost.usd).toBe(0)
  })

  test('GB-months average each day’s peak over the month’s length', () => {
    // Cloudflare's example: 1 GB for 5 days, then 3 GB for 25 days.
    const days = Array.from({ length: 30 }, (_, i) =>
      day(`2026-11-${String(i + 1).padStart(2, '0')}`, (i < 5 ? 1 : 3) * GB),
    )
    expect(monthCost(days, '2026-11').storage.used).toBeCloseTo(80 / 30)
    // A 31-day month divides by 31.
    const december = days.map((d) => ({ ...d, day: d.day.replace('11', '12') }))
    expect(monthCost(december, '2026-12').storage.used).toBeCloseTo(80 / 31)
  })

  test('mid-month, what has accrued so far is billed past the free tier', () => {
    // 15 days of 40 GB in November: 20 GB-months, 10 of them free.
    const days = Array.from({ length: 15 }, (_, i) =>
      day(
        `2026-11-${String(i + 1).padStart(2, '0')}`,
        40 * GB,
        100_000,
        1_000_000,
      ),
    )
    days.push(day('2026-10-31', 1000 * GB, 9e9, 9e9))
    const cost = monthCost(days, '2026-11')
    expect(cost.days).toBe(15)
    expect(cost.storage.used).toBeCloseTo(20)
    expect(cost.storage.billable).toBeCloseTo(10)
    expect(cost.storage.usd).toBeCloseTo(0.15)
    expect(cost.class_a).toMatchObject({ used: 1_500_000, billable: 500_000 })
    expect(cost.class_a.usd).toBeCloseTo(2.25)
    expect(cost.class_b).toMatchObject({ used: 15_000_000 })
    expect(cost.class_b.usd).toBeCloseTo(1.8)
    expect(cost.usd).toBeCloseTo(0.15 + 2.25 + 1.8)
  })

  test('operations fall into the classes the pricing page lists', () => {
    expect(operationClass('PutObject')).toBe('a')
    expect(operationClass('ListObjects')).toBe('a')
    expect(operationClass('CompleteMultipartUpload')).toBe('a')
    expect(operationClass('GetObject')).toBe('b')
    expect(operationClass('HeadObject')).toBe('b')
    expect(operationClass('DeleteObject')).toBe('free')
    expect(operationClass('AbortMultipartUpload')).toBe('free')
    // Unlisted names follow the pattern; unknown ones count as Class A.
    expect(operationClass('GetBucketWebsite')).toBe('b')
    expect(operationClass('DeleteObjects')).toBe('free')
    expect(operationClass('PutBucketTagging')).toBe('a')
  })
})

/** Cloudflare's GraphQL endpoint, answering from canned data. */
function fakeGraphQL(
  options: {
    storage?: unknown[]
    operations?: unknown[]
    settings?: unknown
    fail?: boolean
  } = {},
) {
  const requests: {
    query: string
    variables: Record<string, string>
    auth: string
  }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe('https://cf.test/client/v4/graphql')
    const body = JSON.parse(String(init!.body)) as {
      query: string
      variables: Record<string, string>
    }
    requests.push({
      ...body,
      auth: new Headers(init!.headers).get('authorization') ?? '',
    })
    if (options.fail)
      return Response.json(
        { data: null, errors: [{ message: 'not authorized' }] },
        { status: 200 },
      )
    if (body.query.includes('R2Limits'))
      return Response.json({
        data: {
          viewer: {
            accounts: [{ settings: options.settings ?? null }],
          },
        },
        errors: null,
      })
    return Response.json({
      data: {
        viewer: {
          accounts: [
            {
              storage: options.storage ?? [],
              operations: options.operations ?? [],
            },
          ],
        },
      },
      errors: null,
    })
  }
  return { fetch, requests }
}

const storageRow = (date: string, bucket: string, payload: number) => ({
  max: { objectCount: payload / 100, payloadSize: payload, metadataSize: 10 },
  dimensions: { date, bucketName: bucket },
})
const opRow = (
  date: string,
  bucket: string,
  actionType: string,
  requests: number,
) => ({
  sum: { requests },
  dimensions: { date, bucketName: bucket, actionType },
})

const analytics = (fetch: typeof globalThis.fetch) => ({
  accountId: ACCOUNT,
  token: 'analytics-token',
  fetch,
  apiBase: 'https://cf.test/client/v4',
})
const MONTH = { maxRange: 31 * DAY, retention: 31 * DAY }

describe('the analytics client', () => {
  test('groups storage by day and bucket, operations by class', async () => {
    const { fetch, requests } = fakeGraphQL({
      storage: [
        storageRow('2026-11-25', 'midden', 1000),
        storageRow('2026-11-25', 'midden-backup', 500),
        storageRow('2026-11-26', 'midden', 1200),
      ],
      operations: [
        opRow('2026-11-25', 'midden', 'PutObject', 10),
        opRow('2026-11-25', 'midden', 'ListObjects', 2),
        opRow('2026-11-25', 'midden', 'GetObject', 7),
        opRow('2026-11-25', 'midden', 'DeleteObject', 99),
        opRow('2026-11-26', 'midden-backup', 'PutObject', 3),
      ],
    })
    const now = at('2026-11-26T08:00:00Z')
    const usage = await fetchR2Usage(analytics(fetch), MONTH, now)
    expect(Object.fromEntries(usage.days)).toEqual({
      '2026-11-25': {
        midden: { bytes: 1010, objects: 10, class_a: 12, class_b: 7 },
        'midden-backup': { bytes: 510, objects: 5, class_a: 0, class_b: 0 },
      },
      '2026-11-26': {
        midden: { bytes: 1210, objects: 12, class_a: 0, class_b: 0 },
        'midden-backup': {
          bytes: null,
          objects: null,
          class_a: 3,
          class_b: 0,
        },
      },
    })
    const [request] = requests
    expect(request!.auth).toBe('Bearer analytics-token')
    expect(request!.query).toContain('r2StorageAdaptiveGroups')
    expect(request!.query).toContain('r2OperationsAdaptiveGroups')
    expect(request!.variables).toEqual({
      accountTag: ACCOUNT,
      // Under 31 days back, from a midnight: the first day is whole.
      since: '2026-10-27T00:00:00.000Z',
      until: '2026-11-26T08:00:00.000Z',
    })
    expect(usage.from).toBe('2026-10-27')
  })

  test('the account’s retention narrows the range', async () => {
    const { fetch, requests } = fakeGraphQL({
      settings: {
        r2StorageAdaptiveGroups: {
          maxDuration: 2_678_400,
          notOlderThan: 7 * 86_400,
        },
        r2OperationsAdaptiveGroups: {
          maxDuration: 2_678_400,
          notOlderThan: 2_678_400,
        },
      },
    })
    const limits = await datasetLimits(analytics(fetch))
    expect(limits).toEqual({ maxRange: 31 * DAY, retention: 7 * DAY })
    await fetchR2Usage(analytics(fetch), limits, at('2026-11-26T08:00:00Z'))
    expect(requests[1]!.variables.since).toBe('2026-11-20T00:00:00.000Z')
  })

  test('limits the API does not report are the documented 31 days', async () => {
    const { fetch } = fakeGraphQL({ settings: null })
    expect(await datasetLimits(analytics(fetch))).toEqual(MONTH)
  })

  test('errors name what Cloudflare said, not the token', async () => {
    const { fetch } = fakeGraphQL({ fail: true })
    const error = await fetchR2Usage(analytics(fetch), MONTH, Date.now()).then(
      () => new Error('answered'),
      (error_: unknown) => error_ as Error,
    )
    expect(error.message).toBe('analytics query failed: 200 not authorized')
    expect(error.message).not.toContain('analytics-token')
  })
})

describe('alerts', () => {
  function setup() {
    const db = openDatabase(':memory:')
    const sent: string[] = []
    const check = (facts: Partial<AlertFacts>) =>
      checkAlerts(
        db,
        { month: '2026-11', freeBytes: 100 * GiB, dbBytes: GiB, ...facts },
        (text) => sent.push(text),
      )
    return { db, sent, check }
  }

  test('once on crossing, once on recovery, never while it holds', () => {
    const { sent, check } = setup()
    check({})
    expect(sent).toEqual([])
    check({ freeBytes: 9.5 * GiB })
    check({ freeBytes: 9 * GiB })
    check({ freeBytes: 8 * GiB })
    expect(sent).toEqual(['存储用量：数据盘可用 9.5 GB，低于 10 GB'])
    check({ freeBytes: 12 * GiB })
    check({ freeBytes: 13 * GiB })
    expect(sent.slice(1)).toEqual([
      '存储用量：数据盘可用 12.0 GB，不再低于 10 GB',
    ])
  })

  test('the database, the bill and the operations', () => {
    const { sent, check } = setup()
    check({
      dbBytes: 5.5 * GiB,
      r2: { usd: 5.12, classA: 812_345, classB: 8_000_001 },
    })
    expect(sent).toEqual([
      '存储用量：数据库文件 5.5 GB，超过 5 GB',
      '存储用量：本月 R2 费用 $5.12，超过 $5',
      '存储用量：本月 R2 Class A 操作 812,345 次，超过免费额度 100 万次的 80%',
      '存储用量：本月 R2 Class B 操作 8,000,001 次，超过免费额度 1000 万次的 80%',
    ])
    // Without the analytics the R2 alerts stay raised, quietly.
    check({ dbBytes: 5.5 * GiB })
    expect(sent).toHaveLength(4)
  })

  test('a new month ends the monthly alerts without a message', () => {
    const { sent, check } = setup()
    const r2 = { usd: 6, classA: 0, classB: 0 }
    check({ r2 })
    check({ month: '2026-12', r2: { usd: 0, classA: 0, classB: 0 } })
    expect(sent).toEqual(['存储用量：本月 R2 费用 $6.00，超过 $5'])
    // The new month crosses on its own.
    check({ month: '2026-12', r2 })
    expect(sent).toHaveLength(2)
  })

  test('the thresholds are settings; raising one clears its alert', () => {
    const { db, sent, check } = setup()
    const r2 = { usd: 6, classA: 0, classB: 0 }
    check({ r2 })
    setAlertThresholds(db, { cost_usd: 10 })
    check({ r2 })
    expect(sent).toEqual([
      '存储用量：本月 R2 费用 $6.00，超过 $5',
      '存储用量：本月 R2 费用 $6.00，不再超过 $10',
    ])
  })

  test('a raised alert stays raised across a restart', () => {
    const { db, sent, check } = setup()
    check({ freeBytes: GiB })
    const again: string[] = []
    checkAlerts(
      db,
      { month: '2026-11', freeBytes: GiB, dbBytes: GiB },
      (text) => again.push(text),
    )
    expect(sent).toHaveLength(1)
    expect(again).toEqual([])
  })
})

describe('storage usage', () => {
  let ctx: AccountsContext | undefined
  afterEach(async () => {
    await ctx?.queue.stop()
    ctx = undefined
  })

  function setup(
    options: {
      graphql?: ReturnType<typeof fakeGraphQL>
      db?: Database
      dataDir?: string
      databasePath?: string
    } = {},
  ) {
    const dataDir =
      options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'midden-usage-'))
    const db = options.db ?? openDatabase(':memory:')
    let clock = at('2026-11-26T08:00:00Z')
    const sent: string[] = []
    const { logger, entries } = recordingLogger()
    const composed: string[] = []
    const storage = new StorageUsage({
      db,
      dataDir,
      databasePath: options.databasePath ?? path.join(dataDir, 'midden.db'),
      mediaDir: path.join(dataDir, 'media'),
      ...(options.graphql
        ? { cloudflare: { accountId: ACCOUNT, apiToken: 'analytics-token' } }
        : {}),
      fetch: options.graphql?.fetch,
      apiBase: 'https://cf.test/client/v4',
      logger,
      notify: (text) => sent.push(text),
      now: () => clock,
      readComposition: async (input) => {
        composed.push(input.databasePath)
        return {
          items: [
            { name: 'captures', type: 'table', table: 'captures', bytes: 4096 },
          ],
          total_bytes: 4096,
          media: { files: 0, bytes: 0 },
        }
      },
    })
    return {
      db,
      dataDir,
      storage,
      sent,
      entries,
      composed,
      advance: (ms: number) => (clock += ms),
    }
  }

  test('a tick records the day’s snapshot and the analytics’ days', async () => {
    const graphql = fakeGraphQL({
      storage: [
        storageRow('2026-11-25', 'midden', 1000),
        storageRow('2026-11-26', 'midden', 2000),
      ],
      operations: [opRow('2026-11-26', 'midden', 'PutObject', 5)],
    })
    const { db, storage, dataDir, advance } = setup({ graphql })
    mkdirSync(path.join(dataDir, 'backups', 'deploy'), { recursive: true })
    writeFileSync(
      path.join(dataDir, 'backups', 'deploy', 'a.db'),
      'x'.repeat(10),
    )
    await storage.tick()
    const days = snapshots(db)
    expect(days.map((d) => d.day)).toEqual(['2026-11-25', '2026-11-26'])
    expect(days[0]).toMatchObject({
      r2: { midden: { bytes: 1010 } },
      db_bytes: null,
    })
    expect(days[1]).toMatchObject({
      r2: { midden: { bytes: 2010, class_a: 5 } },
      thumbnail_bytes: 0,
    })
    expect(days[1]!.db_bytes).toBeGreaterThan(0)
    expect(days[1]!.free_bytes).toBeGreaterThan(0)

    // Paced: nothing more within 15 minutes.
    await storage.tick()
    expect(graphql.requests).toHaveLength(2)
    advance(15 * 60_000)
    await storage.tick()
    expect(graphql.requests).toHaveLength(3)

    const report = await storage.report()
    expect(report.r2).toEqual({
      fetched_at: expect.any(String),
      buckets: [
        {
          name: 'midden',
          day: '2026-11-26',
          bytes: 2010,
          objects: 20,
          class_a: 5,
          class_b: 0,
        },
      ],
    })
    expect(report.cost).toMatchObject({ month: '2026-11', days: 2 })
    expect(report.local.deploy_backups).toEqual({ files: 1, bytes: 10 })
    expect(report.alerts).toEqual({
      cost_usd: 5,
      free_disk_gb: 10,
      db_gb: 5,
      ops_percent: 80,
    })
  })

  test('days the analytics no longer cover keep their figures', async () => {
    const graphql = fakeGraphQL({
      storage: [storageRow('2026-10-01', 'midden', 1000)],
    })
    const { db, storage } = setup({ graphql })
    await storage.tick()
    const later = setup({
      db,
      graphql: fakeGraphQL({
        storage: [storageRow('2026-11-26', 'midden', 5)],
      }),
    })
    await later.storage.tick()
    expect(snapshots(db).map((d) => [d.day, d.r2?.midden?.bytes])).toEqual([
      ['2026-10-01', 1010],
      ['2026-11-26', 15],
    ])
  })

  test('without the analytics only the local figures are reported', async () => {
    const failing = setup({ graphql: fakeGraphQL({ fail: true }) })
    const report = await failing.storage.report()
    expect(report.r2).toBeNull()
    expect(report.cost).toBeNull()
    expect(report.local.database.bytes).toBeGreaterThan(0)
    expect(failing.entries).toContainEqual(
      expect.objectContaining({
        level: levels.warn,
        msg: 'storage analytics unavailable',
        reason: 'analytics query failed: 200 not authorized',
      }),
    )
    expect(JSON.stringify(failing.entries)).not.toContain('analytics-token')

    const unconfigured = setup()
    expect(await unconfigured.storage.report()).toMatchObject({
      r2: null,
      cost: null,
    })
  })

  test('a refresh from the page waits a minute after the last', async () => {
    const graphql = fakeGraphQL()
    const { storage, advance } = setup({ graphql })
    await storage.report()
    await storage.report(true)
    const reads = () =>
      graphql.requests.filter((r) => r.query.includes('R2Usage')).length
    expect(reads()).toBe(1)
    advance(60_000)
    await storage.report(true)
    expect(reads()).toBe(2)
  })

  test('the composition is read once a day', async () => {
    const { db, storage, composed, advance } = setup()
    expect(compositionDue(db, at('2026-11-26T08:00:00Z'))).toBe(true)
    await storage.tick()
    await vi.waitFor(() => expect(storedComposition(db)).toBeDefined())
    expect(composed).toHaveLength(1)
    expect(storedComposition(db)).toMatchObject({
      computed_at: '2026-11-26T08:00:00.000Z',
      total_bytes: 4096,
      items: [{ name: 'captures', bytes: 4096 }],
      rest: { count: 0, bytes: 0 },
    })
    advance(23 * 60 * 60_000)
    await storage.tick()
    expect(composed).toHaveLength(1)
    advance(60 * 60_000)
    await storage.tick()
    await vi.waitFor(() => expect(composed).toHaveLength(2))
  })

  test('the worker reads every table and index with dbstat', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'midden-dbstat-'))
    const databasePath = path.join(dataDir, 'midden.db')
    const db = openDatabase(databasePath)
    mkdirSync(path.join(dataDir, 'media', 'ab', 'cd'), { recursive: true })
    writeFileSync(
      path.join(dataDir, 'media', 'ab', 'cd', 'abcd'),
      'x'.repeat(7),
    )
    const { readComposition } = await import('./composition.ts')
    const output = await readComposition({
      databasePath,
      mediaDir: path.join(dataDir, 'media'),
    })
    db.$client.close()
    expect(output.media).toEqual({ files: 1, bytes: 7 })
    const names = output.items.map((item) => item.name)
    expect(names).toContain('captures')
    expect(names).toContain('sqlite_schema')
    expect(output.items.find((i) => i.name === 'storage_snapshots')).toEqual({
      name: 'storage_snapshots',
      type: 'table',
      table: 'storage_snapshots',
      bytes: 4096,
    })
    const index = output.items.find((i) => i.type === 'index')!
    expect(index.table).not.toBe(index.name)
    expect(output.total_bytes).toBe(
      output.items.reduce((sum, item) => sum + item.bytes, 0),
    )
  })

  test('the API reports usage and edits the thresholds', async () => {
    const { db, storage } = setup()
    ctx = testContext()
    const app = createApi({ ctx, storage })
    const token = tokenSecret(ctx.db)
    const call = (url: string, init: RequestInit = {}) =>
      app.request(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
    expect(await (await call('/storage')).json()).toMatchObject({
      r2: null,
      cost: null,
      history: [],
      composition: null,
    })
    const saved = await call('/storage/alerts', {
      method: 'PUT',
      body: JSON.stringify({ cost_usd: 2.5, ops_percent: 50 }),
    })
    expect(await saved.json()).toEqual({
      cost_usd: 2.5,
      free_disk_gb: 10,
      db_gb: 5,
      ops_percent: 50,
    })
    expect(snapshots(db)).toEqual([])
    for (const body of [{ ops_percent: 101 }, { cost_usd: 0 }, { other: 1 }])
      expect(
        (
          await call('/storage/alerts', {
            method: 'PUT',
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400)
    const without = createApi({ ctx })
    expect(
      (
        await without.request('/storage', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404)
  })
})
