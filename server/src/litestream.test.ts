import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { watchLitestream, type LitestreamWatch } from '#litestream.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import type { AddressInfo } from 'node:net'

const MINUTE = 60_000

describe('Litestream heartbeat watch', () => {
  let watch: LitestreamWatch | undefined
  afterEach(() => watch?.close())

  function start() {
    let clock = 0
    const notices: string[] = []
    const { logger, entries } = recordingLogger()
    watch = watchLitestream({
      host: '127.0.0.1',
      port: 0,
      logger,
      notify: (text) => notices.push(text),
      now: () => clock,
    })
    return {
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
    await once(watch.server, 'listening')
    const { port } = watch.server.address() as AddressInfo
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
})
