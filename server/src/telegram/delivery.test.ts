import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { submit } from '#capture/submit.ts'
import { telegramDeliveries } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { handle, type Request } from './commands.ts'
import { DeliveryWorker, enqueueDelivery } from './delivery.ts'
import { Media } from './media.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Api } from 'grammy'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** A Telegram API that records calls and hands out message ids. */
function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = []
  let next = 100
  const record =
    (
      method: string,
      result: (args: unknown[]) => unknown = () => ({ message_id: next++ }),
    ) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return result(args)
    }
  const api = {
    sendMessage: record('sendMessage'),
    editMessageText: record('editMessageText', () => true),
    deleteMessage: record('deleteMessage', () => true),
    editMessageReplyMarkup: record('editMessageReplyMarkup', () => true),
    sendPhoto: record('sendPhoto', () => ({
      message_id: next++,
      photo: [{ file_id: 'photo-id', width: 1, height: 1 }],
    })),
    sendMediaGroup: record('sendMediaGroup', (args) =>
      (args[1] as unknown[]).map(() => ({ message_id: next++ })),
    ),
  }
  return { api: api as unknown as Api, calls }
}

function setup(images: number) {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: 'hello',
          authorName: 'Author',
          resources: Array.from({ length: images }, (_, i) => ({
            url: `https://m.test/${i}.jpg`,
            kind: 'image',
            immutableKey: '',
            altText: '',
            sensitive: false,
            purpose: '',
          })),
          graph: postGraph(req.externalId, {}, undefined, {
            resourceIndices: Array.from({ length: images }, (_, i) => i),
          }),
        }),
      }),
    ],
    handlers: captureHandlers,
    fetch: async (input) =>
      new Response(Buffer.concat([JPEG, Buffer.from(String(input))])),
  })
  ctx.queue.start()
  const { api, calls } = fakeApi()
  const worker = new DeliveryWorker({
    ctx,
    api,
    media: new Media({
      api,
      db: ctx.db,
      blobs: ctx.blobs,
      botId: '1',
      ffprobe: 'ffprobe',
    }),
  })
  return { ctx, worker, calls }
}

const request = (patch: Partial<Request>): Request => ({
  command: 'save',
  arg: '',
  group: false,
  chatId: '42',
  messageId: 1,
  updateId: 7,
  links: [],
  ...patch,
})

describe('telegram delivery', () => {
  test('a text post: status message, then edited into the result', async () => {
    const { ctx, worker, calls } = setup(0)
    const reply = handle(
      { ctx, version: 'dev' },
      request({ links: ['https://fake.test/p/1'] }),
    )
    expect(reply).toEqual({})
    await worker.runDue()
    expect(calls.map((c) => c.method)).toEqual(['sendMessage'])
    expect(calls[0]!.args[1]).toBe('正在采集…\nhttps://fake.test/p/1')
    await ctx.queue.drain()
    ctx.db
      .update(telegramDeliveries)
      .set({ nextAt: new Date(0) })
      .run()
    await worker.runDue()
    const edit = calls.at(-1)!
    expect(edit.method).toBe('editMessageText')
    expect(edit.args[2]).toContain('Author：\nhello')
    expect(ctx.db.select().from(telegramDeliveries).get()?.state).toBe('done')
  })

  test('one photo replaces the status message, then gets the buttons', async () => {
    const { ctx, worker, calls } = setup(1)
    submit(ctx, { url: 'https://fake.test/p/1' })
    await ctx.queue.drain()
    const job = submit(ctx, { url: 'https://fake.test/p/1' })
    enqueueDelivery(ctx, {
      kind: 'submission',
      ref: job.submissionId,
      chatId: '42',
    })
    await worker.runDue()
    expect(calls.map((c) => c.method)).toEqual([
      'sendPhoto',
      'editMessageReplyMarkup',
    ])
    expect((calls[0]!.args[2] as { caption: string }).caption).toContain(
      'hello',
    )
  })

  test('an album goes first, the text follows with the buttons', async () => {
    const { ctx, worker, calls } = setup(3)
    const job = submit(ctx, { url: 'https://fake.test/p/1' })
    await ctx.queue.drain()
    enqueueDelivery(ctx, {
      kind: 'submission',
      ref: job.submissionId,
      chatId: '42',
    })
    await worker.runDue()
    expect(calls.map((c) => c.method)).toEqual([
      'sendMediaGroup',
      'sendMessage',
    ])
    expect(calls[1]!.args[2]).toMatchObject({
      reply_markup: { inline_keyboard: expect.any(Array) },
    })
  })
})

describe('telegram commands', () => {
  test('help, usage, list and errors', async () => {
    const { ctx } = setup(0)
    const c = { ctx, version: 'abc' }
    const start = handle(c, request({ command: 'start' }))
    expect(start.text).toContain('版本：abc')
    expect(start.entities).toEqual([
      { type: 'code', offset: start.text!.length - 3, length: 3 },
    ])
    const sha = '0123456789abcdef0123456789abcdef01234567'
    for (const [version, label] of [
      [sha, '0123456'],
      [`${sha}-dirty`, '0123456-dirty'],
    ]) {
      const reply = handle({ ctx, version }, request({ command: 'start' }))
      expect(reply.text).toContain(`\n\n版本：${label}`)
      expect(reply.entities).toEqual([
        {
          type: 'text_link',
          offset: reply.text!.length - label.length,
          length: label.length,
          url: `https://github.com/sxzz/midden/commit/${sha}`,
        },
      ])
    }
    expect(handle(c, request({ command: 'list' }))).toEqual({
      text: '收藏列表是空的。',
      keyboard: [],
    })
    submit(ctx, { url: 'https://fake.test/p/1' })
    await ctx.queue.drain()
    const list = handle(c, request({ command: 'list' }))
    expect(list.text).toBe('1. hello')
    expect(handle(c, request({ command: 'usage' })).text).toMatch(
      /^已用 \d+\.\d MiB$/,
    )
    expect(handle(c, request({ command: 'show', arg: 'nope' })).text).toBe(
      '操作失败，使用 /help 查看用法。',
    )
    expect(handle(c, request({ command: 'list', group: true })).text).toBe(
      '请在私聊中使用此命令。',
    )
    expect(
      handle(
        c,
        request({
          links: Array.from(
            { length: 201 },
            (_, i) => `https://fake.test/p/${i}`,
          ),
        }),
      ).text,
    ).toBe('每次最多 200 个链接。')
    expect(handle(c, request({})).text).toBe('请发送支持的链接，或使用 /help。')
  })

  test('accounts: list, confirm and delete', async () => {
    const { ctx } = setup(0)
    const { addAccount } = await import('#accounts/accounts.ts')
    const { id } = await addAccount(ctx, 'fake', {
      credential: Buffer.from('alice'),
      name: 'Main',
    })
    const c = { ctx, version: 'dev' }
    const list = handle(c, request({ command: 'account' }))
    expect(list.keyboard!.flat().map((b) => b.text)).toEqual([
      'Fake · 公共来源',
      '✓ @fake · Main',
      '删除',
    ])
    expect(
      handle(c, request({ command: 'account_delete', arg: id })).text,
    ).toBe('删除采集账号 Main？')
    expect(
      handle(c, request({ command: 'account_delete', arg: `confirm:${id}` }))
        .text,
    ).toBe('账号已删除。')
  })
})
