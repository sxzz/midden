// A small archive and the agent API over it, for the agent API's tests:
// two accounts on the fake platform and a few posts, captured through the
// real pipeline, read in place (`inlineReads`) unless a test says otherwise.
import { createAgentApi } from '#agent/app.ts'
import { inlineReads, typeCatalog, type Reads } from '#agent/runner.ts'
import { createToken, type Permission } from '#tokens/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { adminId } from '#users/users.ts'
import { fakeProfile } from './fake-platform.ts'
import { capture, entity, graph, image, libraryContext } from './library.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Gate } from '#agent/gate.ts'
import type { AgentReader } from '#agent/query.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

export const post = (id: string) => `https://fake.test/p/${id}`
export const profile = (id: string) => `https://fake.test/u/${id}`

export const ACCOUNTS: Record<string, Record<string, unknown>> = {
  '7': {
    username: 'alice',
    name: 'Alice',
    metadata: {
      description: 'Alice draws cats.',
      followers: 120,
      following: 5,
    },
  },
  '8': {
    username: 'bob',
    name: 'Bob',
    metadata: { description: 'Bob walks dogs.', followers: 30, following: 50 },
  },
}

/** A post by account `author`, maybe quoting another post. */
function postOf(
  id: string,
  author: string,
  text: string,
  extra: { likes?: number; quotes?: string } = {},
): Partial<FetchResponse> {
  return {
    text,
    graph: graph(
      [
        entity('root', 'fake.post', id, {
          text,
          ...(extra.likes === undefined ? {} : { likes: extra.likes }),
        }),
        entity('author', 'fake.profile', author, ACCOUNTS[author]),
        ...(extra.quotes
          ? [entity('quoted', 'fake.post', extra.quotes, { text: '' })]
          : []),
      ],
      ['root', 'authored_by', 'author'],
      ...(extra.quotes
        ? [['root', 'quoted', 'quoted'] as [string, string, string]]
        : []),
    ),
  }
}

/** A long post with a photo: compact views cut the one and count the other. */
export const LONG_TEXT = `Walking notes: ${'the dog and I went around the park again. '.repeat(10)}`

const ROUTES: Record<string, () => Partial<FetchResponse>> = {
  '7': () => fakeProfile('7', ACCOUNTS['7']),
  '8': () => fakeProfile('8', ACCOUNTS['8']),
  p1: () => postOf('p1', '7', 'A cat on the mat', { likes: 3 }),
  p2: () => postOf('p2', '7', 'Look at this 猫猫', { quotes: 'p1' }),
  p3: () => postOf('p3', '8', 'A dog day', { likes: 9 }),
  p4: () => {
    const response = postOf('p4', '8', LONG_TEXT)
    response.resources = [image('walk.jpg', { altText: 'a dog in a park' })]
    response.graph!.entities[0]!.resourceIndices = [0]
    return response
  },
}

export interface AgentFixture {
  ctx: AccountsContext
  reader: AgentReader
  usage: TokenUsage
  ids: Record<string, string>
  app: ReturnType<typeof createAgentApi>
  /** A token's secret. */
  token: (permission?: Permission, expiresAt?: Date | null) => string
  call: (
    path: string,
    init?: { token?: string; method?: string; body?: unknown },
  ) => Promise<{ status: number; json: any; headers: Headers }>
}

export async function agentFixture(
  options: { reads?: (reader: AgentReader) => Reads; gate?: Gate } = {},
): Promise<AgentFixture> {
  const { ctx } = libraryContext((req) => {
    const route = ROUTES[req.externalId]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    return route()
  })
  const ids: Record<string, string> = {}
  for (const id of ['7', '8'])
    ids[id] = (await capture(ctx, profile(id))).collectionId
  for (const id of ['p1', 'p2', 'p3', 'p4'])
    ids[id] = (await capture(ctx, post(id))).collectionId
  const reader: AgentReader = {
    db: ctx.db,
    blobs: ctx.blobs,
    types: typeCatalog(ctx.platforms),
  }
  const usage = new TokenUsage({ db: ctx.db })
  const app = createAgentApi({
    ctx: ctx as AccountsContext,
    reads: (options.reads ?? inlineReads)(reader),
    reader,
    usage,
    ...(options.gate ? { gate: options.gate } : {}),
  })
  const rw = createToken(ctx.db, {
    user: adminId(ctx.db),
    label: 'agent',
    permission: 'rw',
  }).secret
  return {
    ctx: ctx as AccountsContext,
    reader,
    usage,
    ids,
    app,
    token: (permission = 'rw', expiresAt = null) =>
      createToken(ctx.db, {
        user: adminId(ctx.db),
        label: permission,
        permission,
        expiresAt,
      }).secret,
    call: async (path, init = {}) => {
      const response = await app.request(`/agent/v1${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${init.token ?? rw}`,
          ...(init.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      return {
        status: response.status,
        json: await response.json(),
        headers: response.headers,
      }
    },
  }
}
