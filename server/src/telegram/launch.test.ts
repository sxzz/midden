import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { testContext } from '#testing/context.ts'
import { defaultReply, FakeTelegram } from '#testing/fake-telegram.ts'
import { recordingLogger, type LogEntry } from '#testing/logs.ts'
import { launchBot, type BotHandle, type LaunchOptions } from './launch.ts'

let telegram: FakeTelegram
let handle: BotHandle | undefined
beforeEach(async () => {
  telegram = await new FakeTelegram().start()
})
afterEach(async () => {
  await handle?.stop()
  handle = undefined
  await telegram.stop()
})

function launch(options: Partial<LaunchOptions> = {}) {
  const { logger, entries } = recordingLogger()
  const ctx = testContext({ logger })
  handle = launchBot({
    ctx,
    token: '1:test',
    owner: '7',
    version: 'test',
    client: { apiRoot: telegram.apiRoot },
    requestTimeoutMs: 100,
    retryDelayMs: 10,
    stopTimeoutMs: 200,
    ...options,
  })
  return { handle, entries, ctx }
}

const messages = (entries: LogEntry[]) => entries.map((entry) => entry.msg)

describe('launching the bot', () => {
  test('a request that never answers times out and the setup is tried again', async () => {
    let getMe = 0
    telegram.reply = (call) =>
      call.method === 'getMe' && ++getMe === 1 ? 'hang' : defaultReply(call)
    const { handle, entries, ctx } = launch()
    expect(handle.state()).toBe('starting')
    await handle.settled
    expect(handle.state()).toBe('running')
    const retry = entries.find(
      (entry) => entry.msg === 'telegram bot start failed; retrying',
    )!
    expect(retry).toMatchObject({ attempt: 1, retryInMs: 10 })
    expect(retry.err.message).toMatch(/^Telegram getMe timed out after 100 ms/)
    expect(
      entries.find((entry) => entry.msg === 'telegram bot started'),
    ).toMatchObject({ attempt: 2 })
    expect(telegram.methods().slice(0, 6)).toEqual([
      'getMe',
      'getMe',
      'setMyCommands',
      'setMyCommands',
      'setChatMenuButton',
      'setChatMenuButton',
    ])
    await handle.stop()
    await ctx.queue.stop()
  })

  test('Telegram asking to wait is respected', async () => {
    let calls = 0
    telegram.reply = (call) =>
      call.method === 'setMyCommands' && ++calls === 1
        ? {
            error_code: 429,
            description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 1 },
          }
        : defaultReply(call)
    const { handle, entries } = launch()
    await handle.settled
    expect(handle.state()).toBe('running')
    expect(
      entries.find(
        (entry) => entry.msg === 'telegram bot start failed; retrying',
      ),
    ).toMatchObject({ retryInMs: 1000 })
  })

  test('a refused token ends the attempts; notices are dropped', async () => {
    telegram.reply = () => ({ error_code: 401, description: 'Unauthorized' })
    const { handle, entries } = launch()
    handle.notify('held')
    await handle.settled
    expect(handle.state()).toBe('failed')
    expect(telegram.methods()).toEqual(['getMe'])
    expect(messages(entries)).toContain('telegram bot could not start')
    expect(
      entries.find((entry) => entry.msg === 'telegram notice dropped'),
    ).toMatchObject({ text: 'held' })
  })

  test('notices from before the bot runs are sent once it does', async () => {
    telegram.reply = (call) =>
      call.method === 'getMe' && telegram.calls.length === 1
        ? 'hang'
        : defaultReply(call)
    const { handle } = launch()
    handle.notify('数据库备份：Litestream 的心跳已恢复')
    await handle.settled
    expect(handle.state()).toBe('running')
    await expect
      .poll(() => telegram.calls.find((call) => call.method === 'sendMessage'))
      .toMatchObject({
        body: { chat_id: 7, text: '数据库备份：Litestream 的心跳已恢复' },
      })
  })

  test('stopping during the setup ends it at once', async () => {
    telegram.reply = () => 'hang'
    const { handle, entries } = launch({ requestTimeoutMs: 60_000 })
    await expect.poll(() => telegram.calls.length).toBe(1)
    const started = Date.now()
    await handle.stop()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(handle.state()).toBe('stopped')
    expect(messages(entries)).not.toContain(
      'telegram bot start failed; retrying',
    )
  })
})
