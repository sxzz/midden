import { Hono, type Context } from 'hono'
import * as v from 'valibot'
import { endpointOf } from '#http/auth.ts'
import { authenticate, bearer } from '#tokens/tokens.ts'
import { AgentError, errorBody, invalid, notFound } from './errors.ts'
import { Gate } from './gate.ts'
import {
  body,
  errorResponse,
  originOf,
  queries,
  type AgentEnv,
} from './http.ts'
import { QUERY_TIMEOUT_MS } from './pool.ts'
import { MAX_PAGE_SIZE, type AgentReader } from './query.ts'
import { BATCH_MAX } from './reads.ts'
import { VIEWS, type View } from './shape.ts'
import { writeRoutes } from './writes.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { TokenUsage } from '#tokens/usage.ts'
import type { Reads } from './runner.ts'

export interface AgentOptions {
  ctx: AccountsContext
  /** Where reads run: a pool of read threads, or in place in tests. */
  reads: Reads
  /** Reads on this thread, for what writes look up and answer. */
  reader: AgentReader
  usage: TokenUsage
  gate?: Gate
  now?: () => number
}

const Batch = v.strictObject({
  ids: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(BATCH_MAX)),
  view: v.optional(v.picklist(VIEWS)),
  platform: v.optional(v.string()),
})

/** A single read's `view`: full unless asked otherwise. */
function viewParam(c: Context, fallback: View): View {
  const raw = c.req.query('view')
  if (raw === undefined) return fallback
  if (!VIEWS.includes(raw as View))
    throw invalid('view must be one of: compact, full.')
  return raw as View
}

/**
 * The agent API, `/agent/v1`: JSON for AI agents and scripts, with an API
 * token only. Reads run on read threads, so a slow query never holds up the
 * web app; at most `IN_FLIGHT` requests run at once across every token.
 * Nothing here deletes: what deletes is on `/v1`, for the owner's session.
 */
export function createAgentApi(o: AgentOptions) {
  const { ctx, reads, usage } = o
  const now = o.now ?? Date.now
  const gate = o.gate ?? new Gate()
  const app = new Hono<AgentEnv>().basePath('/agent/v1')
  app.onError((error, c) => {
    if (!(error instanceof AgentError) && errorBody(error).error === 'internal')
      ctx.logger.error({ err: error, path: c.req.path }, 'agent request failed')
    return errorResponse(c, error)
  })
  app.use(async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const header = c.req.header('Authorization')
    if (header === undefined)
      throw new AgentError(
        'token_invalid',
        'Send Authorization: Bearer <token>. Ask the owner for a token.',
      )
    const auth = authenticate(ctx.db, bearer(header), now())
    if (!auth.ok)
      throw new AgentError(
        auth.error,
        auth.error === 'token_expired'
          ? 'This token has expired. Stop and ask the owner for a new one.'
          : 'This token is not valid (revoked, rolled or mistyped). Stop and ask the owner for a new one.',
      )
    c.set('token', auth.token)
    try {
      const leave = await gate.enter()
      try {
        await next()
      } finally {
        leave()
      }
    } finally {
      usage.record(auth.token.id, endpointOf(c))
    }
  })

  app.get('/whoami', (c) => {
    const token = c.get('token')
    return c.json({
      token: {
        id: token.id,
        label: token.label,
        permission: token.permission,
        created_at: token.createdAt.toISOString(),
        expires_at: token.expiresAt?.toISOString() ?? null,
      },
      usage: { today: usage.today(ctx.db, token.id) },
      limits: {
        in_flight: gate.limit,
        page_size_max: MAX_PAGE_SIZE,
        batch_max: BATCH_MAX,
        query_timeout_ms: QUERY_TIMEOUT_MS,
      },
    })
  })

  // --- Posts and accounts ---------------------------------------------------
  for (const kind of ['posts', 'accounts'] as const) {
    app.get(`/${kind}`, async (c) =>
      c.json(
        await reads.run('search', {
          kind,
          params: queries(c),
          origin: originOf(c),
        }),
      ),
    )
    app.post(`/${kind}/batch`, async (c) => {
      const input = await body(c, Batch)
      return c.json(
        await reads.run('get', {
          kind,
          refs: input.ids,
          view: input.view ?? 'full',
          origin: originOf(c),
          ...(input.platform ? { platform: input.platform } : {}),
        }),
      )
    })
    app.get(`/${kind}/:id/metrics`, async (c) =>
      c.json(
        await reads.run('metrics', {
          kind,
          ref: c.req.param('id'),
          params: queries(c),
        }),
      ),
    )
    app.get(`/${kind}/:id`, async (c) => {
      const ref = c.req.param('id')
      const { items } = await reads.run('get', {
        kind,
        refs: [ref],
        view: viewParam(c, 'full'),
        origin: originOf(c),
        ...(c.req.query('platform')
          ? { platform: c.req.query('platform') }
          : {}),
      })
      if (!items[0]) throw notFound()
      return c.json(items[0])
    })
  }
  app.get('/posts/:id/context', async (c) =>
    c.json(
      await reads.run('context', {
        id: c.req.param('id'),
        origin: originOf(c),
      }),
    ),
  )
  const accountRead =
    (name: 'history' | 'relations' | 'relationChanges') => async (c: Context) =>
      c.json(
        await reads.run(name, {
          ref: c.req.param('id')!,
          params: queries(c),
          origin: originOf(c),
        }),
      )
  app.get('/accounts/:id/history', accountRead('history'))
  app.get('/accounts/:id/relations', accountRead('relations'))
  app.get('/accounts/:id/relation-changes', accountRead('relationChanges'))

  // --- Folders, tags, captures --------------------------------------------
  app.get('/folders', async (c) =>
    c.json(await reads.run('folders', undefined)),
  )
  app.get('/tags', async (c) => c.json(await reads.run('tags', undefined)))
  app.get('/updates/:id', async (c) =>
    c.json(await reads.run('status', { id: c.req.param('id') })),
  )
  app.get('/jobs', async (c) => c.json(await reads.run('queue', undefined)))
  app.get('/watches', async (c) => c.json(await reads.run('watches', {})))

  writeRoutes(app, { ctx, reader: o.reader, reads })

  app.all('*', () => {
    throw notFound('No such endpoint. See /agent.md.')
  })
  return app
}
