import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { captureURL } from '#capture/records.ts'
import { accountCredentials, captures, connections } from '#db/schema.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import { FakeFailure, fakePlatform } from '#testing/fake-platform.ts'
import {
  addAccount,
  listAccounts,
  revokeAccount,
  selectAccount,
  type AccountsContext,
} from './accounts.ts'
import { Vault } from './vault.ts'
import type { FetchRequest } from '#platforms/protocol.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  const requests: FetchRequest[] = []
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          requests.push(req)
          // Needs the account, and says so when it was withheld.
          if (req.credentialDeferred && !req.credential)
            throw new FakeFailure(status.FAILED_PRECONDITION, '需要采集账号', {
              'credential-required': '1',
            })
          return { text: Buffer.from(req.credential?.data ?? []).toString() }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  return { ctx, requests }
}

const credential = (value: string) => ({ credential: Buffer.from(value) })

describe('accounts', () => {
  test('an imported account is selected and lent only when needed', async () => {
    const { ctx, requests } = setup()
    const { id } = await addAccount(ctx, 'fake', credential('alice'))
    expect(listAccounts(ctx).platforms[0]).toMatchObject({
      id: 'fake',
      public: true,
      canAdd: true,
      selected: id,
    })
    const job = captureURL(ctx, 'https://fake.test/p/1')
    expect(job.accessScope).toBe(`connection:${id}`)
    await ctx.queue.drain()
    expect(
      requests.map((r) => [r.credentialDeferred, Boolean(r.credential)]),
    ).toEqual([
      [true, false],
      [false, true],
    ])
    expect(
      ctx.db.select().from(captures).where(eq(captures.id, job.id)).get(),
    ).toMatchObject({ state: 'complete' })
  })

  test('importing the same account again updates it', async () => {
    const { ctx } = setup()
    const first = await addAccount(ctx, 'fake', credential('alice'))
    const again = await addAccount(ctx, 'fake', {
      ...credential('alice'),
      name: 'Main',
    })
    expect(again.id).toBe(first.id)
    expect(ctx.db.select().from(connections).get()).toMatchObject({
      name: 'Main',
      revision: 2,
    })
    // The replaced credential is gone.
    expect(ctx.db.select().from(accountCredentials).all()).toHaveLength(1)
  })

  test('a revoked account fails the captures still waiting for it', async () => {
    const { ctx } = setup()
    const { id } = await addAccount(ctx, 'fake', credential('alice'))
    const job = captureURL(ctx, 'https://fake.test/p/1')
    revokeAccount(ctx, id)
    await ctx.queue.drain()
    expect(
      ctx.db.select().from(captures).where(eq(captures.id, job.id)).get(),
    ).toMatchObject({
      state: 'failed',
      error: '账号不可用，请在采集账号中选择可用账号或重新授权。',
    })
    expect(listAccounts(ctx).platforms[0]!.selected).toBe('')
    expect(() => selectAccount(ctx, 'fake', id)).toThrow('内容不存在或已删除')
    expect(() => selectAccount(ctx, 'fake', '')).not.toThrow()
  })

  test('the vault refuses tampered or moved ciphertext', () => {
    const vault = new Vault(new Uint8Array(32).fill(1))
    const sealed = vault.seal('a', Buffer.from('secret'))
    expect(vault.unseal('a', sealed).toString()).toBe('secret')
    expect(() => vault.unseal('b', sealed)).toThrow()
    sealed[20]! ^= 1
    expect(() => vault.unseal('a', sealed)).toThrow()
  })
})
