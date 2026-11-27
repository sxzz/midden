import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { openDatabase } from '#db/client.ts'
import { watchLitestream, type LitestreamWatch } from '#litestream.ts'
import {
  heartbeatTimeoutMinutes,
  setHeartbeatTimeoutMinutes,
} from '#settings.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import type { AddressInfo } from 'node:net'

const MINUTE = 60_000

describe('Litestream heartbeat watch', () => {
  let watch: LitestreamWatch | undefined
  afterEach(() => watch?.close())

  function start(db = openDatabase(':memory:'), begin = 0) {
    let clock = begin
    const notices: string[] = []
    const { logger, entries } = recordingLogger()
    watch = watchLitestream({
      db,
      host: '127.0.0.1',
      port: 0,
      logger,
      notify: (text) => notices.push(text),
      now: () => clock,
    })
    return {
      db,
      watch,
      notices,
      entries,
      advance: (ms: number) => {
        clock += ms
        watch!.check()
      },
    }
  }

  test('quiet while heartbeats arrive', () => {
    const { watch, notices, advance } = start()
    for (let i = 0; i < 12; i++) {
      advance(5 * MINUTE)
      watch.beat()
    }
    expect(notices).toEqual([])
  })

  test('tells the owner once when they stop, and when they resume', () => {
    const { watch, notices, entries, advance } = start()
    advance(19 * MINUTE)
    expect(notices).toEqual([])
    advance(MINUTE)
    advance(MINUTE)
    advance(60 * MINUTE)
    expect(notices).toEqual(['数据库备份：20 分钟没有收到 Litestream 的心跳'])
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.error,
        msg: 'litestream heartbeat missing',
      }),
    )

    watch.beat()
    watch.beat()
    expect(notices.slice(1)).toEqual(['数据库备份：Litestream 的心跳已恢复'])

    advance(20 * MINUTE)
    expect(notices).toHaveLength(3)
  })

  test('counts a GET of the heartbeat path, nothing else', async () => {
    const { watch, notices, advance } = start()
    await once(watch.server!, 'listening')
    const { port } = watch.server!.address() as AddressInfo
    const url = `http://127.0.0.1:${port}`

    advance(25 * MINUTE)
    expect(notices).toHaveLength(1)
    expect((await fetch(`${url}/healthz`)).status).toBe(404)
    expect(
      (await fetch(`${url}/litestream/heartbeat`, { method: 'POST' })).status,
    ).toBe(404)
    expect(notices).toHaveLength(1)
    expect((await fetch(`${url}/litestream/heartbeat`)).status).toBe(204)
    expect(notices).toHaveLength(2)
  })

  test('logs the first heartbeat and each recovery, not every heartbeat', () => {
    const { watch, entries, advance } = start()
    const info = () =>
      entries
        .filter((entry) => entry.level === levels.info)
        .map((entry) => entry.msg)
    for (let i = 0; i < 5; i++) {
      advance(5 * MINUTE)
      watch.beat()
    }
    expect(info()).toEqual(['litestream heartbeat received'])

    advance(20 * MINUTE)
    watch.beat()
    watch.beat()
    expect(info()).toEqual([
      'litestream heartbeat received',
      'litestream heartbeat resumed',
    ])
  })

  test('reports the last heartbeat and whether it is stale', () => {
    const { watch, advance } = start()
    expect(watch.status()).toEqual({
      enabled: true,
      last_heartbeat_at: null,
      stale: false,
      stale_after_minutes: 20,
    })
    advance(3 * MINUTE)
    watch.beat()
    advance(19 * MINUTE)
    expect(watch.status()).toMatchObject({
      last_heartbeat_at: new Date(3 * MINUTE).toISOString(),
      stale: false,
    })
    advance(MINUTE)
    expect(watch.status().stale).toBe(true)
    watch.beat()
    expect(watch.status().stale).toBe(false)
  })

  test('reads the threshold from the setting on every check', () => {
    const { watch, db, notices, advance } = start()
    setHeartbeatTimeoutMinutes(db, 3)
    advance(2 * MINUTE)
    expect(notices).toEqual([])
    expect(watch.status().stale_after_minutes).toBe(3)
    advance(MINUTE)
    expect(notices).toEqual(['数据库备份：3 分钟没有收到 Litestream 的心跳'])

    watch.beat()
    setHeartbeatTimeoutMinutes(db, 60)
    advance(59 * MINUTE)
    expect(notices).toHaveLength(2)
    advance(MINUTE)
    expect(notices.at(-1)).toBe('数据库备份：60 分钟没有收到 Litestream 的心跳')
  })

  test('keeps the last heartbeat across a restart, counting silence from the start', () => {
    const first = start()
    first.advance(5 * MINUTE)
    first.watch.beat()
    first.watch.close()

    const second = start(first.db, 8 * MINUTE)
    expect(second.watch.status()).toMatchObject({
      last_heartbeat_at: new Date(5 * MINUTE).toISOString(),
      stale: false,
    })
    second.advance(19 * MINUTE)
    expect(second.notices).toEqual([])
    second.advance(MINUTE)
    expect(second.notices).toHaveLength(1)
  })

  test('the threshold defaults to 20 minutes and ignores bad values', () => {
    const { db } = start()
    expect(heartbeatTimeoutMinutes(db)).toBe(20)
    db.$client.exec(
      "INSERT INTO settings VALUES ('litestream_timeout_minutes', '0')",
    )
    expect(heartbeatTimeoutMinutes(db)).toBe(20)
  })
})
