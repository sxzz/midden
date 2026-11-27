import assert from 'node:assert/strict'
import { test } from 'vitest'
import { status } from '../rpc.ts'
import { identifyHandle, sessionAnswer } from './identify.ts'
import { ProviderError } from './provider.ts'

const credential = { authToken: 'a'.repeat(40), csrfToken: 'b'.repeat(64) }
const found = (id: string) => ({ code: 200, user: { id, screen_name: 'x' } })
const notFound = { code: 404, message: 'User not found' }

/** FxTwitter answering by the handle asked; what was asked, in order. */
function fx(answers: Record<string, unknown>) {
  const asked: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const handle = decodeURIComponent(
      new URL(String(input)).pathname.split('/').pop()!,
    )
    asked.push(handle)
    const body = (answers[handle] ?? notFound) as { code: number }
    return Response.json(body, { status: body.code })
  }) as typeof fetch
  return { asked, fetcher }
}
const signal = () => AbortSignal.timeout(1000)

test('FxTwitter by the handle as written, then in lower case', async () => {
  const first = fx({ VueUse: found('1') })
  assert.equal(await identifyHandle('VueUse', signal(), undefined, first), '1')
  assert.deepEqual(first.asked, ['VueUse'])
  const lower = fx({ vueuse: found('1') })
  assert.equal(await identifyHandle('VueUse', signal(), undefined, lower), '1')
  assert.deepEqual(lower.asked, ['VueUse', 'vueuse'])
  // Already in lower case: asked once.
  const once = fx({})
  await identifyHandle('vueuse', signal(), undefined, once).catch(() => {})
  assert.deepEqual(once.asked, ['vueuse'])
})

test('a suspended account still names its id', async () => {
  const { fetcher } = fx({
    gone: {
      code: 404,
      message: 'User is suspended',
      reason: 'suspended',
      id: '42',
    },
  })
  assert.equal(
    await identifyHandle('gone', signal(), undefined, { fetcher }),
    '42',
  )
})

test('without an answer and without an account: transient, saying nothing', async () => {
  const { fetcher } = fx({ broken: { code: 500, message: 'error' } })
  for (const handle of ['Nobody', 'broken'])
    await assert.rejects(
      identifyHandle(handle, signal(), undefined, { fetcher }),
      (e: any) =>
        e.code === status.UNAVAILABLE &&
        e.handleMiss &&
        !e.notFound &&
        e.message === '暂时无法读取（平台按用户名查询失败）',
    )
})

test('X with the account only when FxTwitter fails: its answer is definite', async () => {
  const asked: string[] = []
  const session = (answer: Awaited<ReturnType<typeof sessionAnswer>>) =>
    (async (handle) => {
      asked.push(handle)
      return answer
    }) satisfies typeof sessionAnswer
  const ok = fx({ VueUse: found('1') })
  assert.equal(
    await identifyHandle('VueUse', signal(), () => credential, {
      ...ok,
      session: session({ id: '9' }),
    }),
    '1',
  )
  assert.deepEqual(asked, [])
  const { fetcher } = fx({})
  assert.equal(
    await identifyHandle('VueUse', signal(), () => credential, {
      fetcher,
      session: session({ id: '1' }),
    }),
    '1',
  )
  await assert.rejects(
    identifyHandle('Nobody', signal(), () => credential, {
      fetcher,
      session: session('none'),
    }),
    (e: any) =>
      e.code === status.FAILED_PRECONDITION &&
      e.notFound &&
      e.message === '没有使用这个用户名的账号',
  )
  await assert.rejects(
    identifyHandle('Nobody', signal(), () => credential, {
      fetcher,
      session: session('miss'),
    }),
    (e: any) => e.handleMiss,
  )
  assert.deepEqual(asked, ['VueUse', 'Nobody', 'Nobody'])
})

test('a rate limit is waited for, not taken for a missing account', async () => {
  const { fetcher } = fx({ VueUse: { code: 429, message: 'limited' } })
  await assert.rejects(
    identifyHandle('VueUse', signal(), () => credential, {
      fetcher,
      session: async () => assert.fail('must wait for the limit'),
    }),
    (e: any) => e.rateLimited,
  )
})

test("X's answer is no account only when X said so, not when the request failed", async () => {
  const failing = {
    fetch: async () => {
      throw new ProviderError(
        status.UNAVAILABLE,
        '来源平台暂时不可用，请稍后重试',
      )
    },
  }
  await assert.rejects(
    sessionAnswer('VueUse', credential, signal(), failing),
    /来源平台暂时不可用/,
  )
  const empty = { fetch: async () => Response.json({ data: {} }) }
  assert.equal(
    await sessionAnswer('Nobody', credential, signal(), empty),
    'none',
  )
})
