import { Hono, type Context } from 'hono'
import * as v from 'valibot'
import { endpointOf, openToViewers, viewers } from '#http/auth.ts'
import { LANES } from '#reads/pool.ts'
import { authenticate, bearer } from '#tokens/tokens.ts'
import { writes } from '#users/principal.ts'
import { userView } from '#users/users.ts'
import { AgentError, errorBody, invalid, notFound } from './errors.ts'
import { Gate, ViewerGates } from './gate.ts'
import {
  body,
  errorResponse,
  originOf,
  queries,
  type AgentEnv,
} from './http.ts'
import { MAX_PAGE_SIZE, type ReadBase } from './query.ts'
import { BATCH_MAX } from './reads.ts'
import { laneOf, type Reads } from './runner.ts'
import { VIEWS, type View } from './shape.ts'
import { writeRoutes } from './writes.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { TokenUsage } from '#tokens/usage.ts'

export interface AgentOptions {
  ctx: AccountsContext
  /** Where reads run: a pool of read threads, or in place in tests. */
  reads: Reads
  /** Reads on this thread, for what writes look up and answer. */
  reader: ReadBase
  usage: TokenUsage
  /** The admin's tokens' turns. */
  gate?: Gate
  /** Viewers' tokens' turns, apart from the admin's. */
  viewerGates?: ViewerGates
  now?: () => number
  /** After every request that may have written (not `GET`). */
  onWrite?: () => void
  /**
   * The web app's address (WEB_APP_URL), for public links; without it the
   * web app is taken to be on the API's own host.
   */
  webAppUrl?: string
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
 * token only. Reads run on the read threads the web app shares (in their
 * `agent` lane), so a slow query never holds up the web app; at most
 * `IN_FLIGHT` requests run at once across every token. A viewer's token
 * reaches only the routes that say `viewers`, and only reads.
 * Nothing here deletes: what deletes is on `/v1`, for the admin's session.
 */
export function createAgentApi(o: AgentOptions) {
  const { ctx, reads, usage } = o
  const now = o.now ?? Date.now
  const gate = o.gate ?? new Gate()
  const viewerGates = o.viewerGates ?? new ViewerGates()
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
        'Send Authorization: Bearer <token>. Ask the human who runs you for a token.',
      )
    const auth = authenticate(ctx.db, bearer(header), now())
    if (!auth.ok)
      throw new AgentError(
        auth.error,
        auth.error === 'token_expired'
          ? 'This token has expired. Stop and ask the human for a new one.'
          : 'This token is not valid (revoked, rolled or mistyped). Stop and ask the human for a new one.',
      )
    const { token } = auth
    c.set('token', token)
    c.set('principal', {
      userId: token.userId,
      role: token.role,
      via: 'token',
      permission: token.permission,
    })
    try {
      // Before the gate: a refused request waits for nothing.
      if (!openToViewers(c))
        throw new AgentError(
          'forbidden',
          'This endpoint is for the admin only. See agent.md.',
        )
      const leave =
        token.role === 'admin'
          ? await gate.enter()
          : await viewerGates.enter(token.userId)
      try {
        await next()
      } finally {
        leave()
      }
    } finally {
      usage.record(auth.token.id, endpointOf(c))
      if (c.req.method !== 'GET') o.onWrite?.()
    }
  })

  // Whose token, what it may do, and the limits of the lane it runs in:
  // the admin's tokens share theirs; viewers have one of their own.
  app.get('/whoami', viewers, (c) => {
    const token = c.get('token')
    const principal = c.get('principal')
    const admin = principal.role === 'admin'
    return c.json({
      user: userView(ctx.db, token.userId),
      token: {
        id: token.id,
        label: token.label,
        // What it may do: a viewer's reads only, whatever it was made as.
        permission: writes(principal) ? token.permission : ('ro' as const),
        created_at: token.createdAt.toISOString(),
        expires_at: token.expiresAt?.toISOString() ?? null,
      },
      usage: { today: usage.today(ctx.db, token.id) },
      limits: {
        in_flight: admin ? gate.limit : viewerGates.perUser,
        lane_in_flight: admin ? gate.limit : viewerGates.shared.limit,
        page_size_max: MAX_PAGE_SIZE,
        batch_max: BATCH_MAX,
        query_timeout_ms: LANES[laneOf(principal)].timeoutMs,
      },
    })
  })

  // --- Posts and accounts ---------------------------------------------------
  for (const kind of ['posts', 'accounts'] as const) {
    app.get(`/${kind}`, viewers, async (c) =>
      c.json(
        await reads.run(c.get('principal'), 'search', {
          kind,
          params: queries(c),
          origin: originOf(c),
        }),
      ),
    )
    app.post(`/${kind}/batch`, viewers, async (c) => {
      const input = await body(c, Batch)
      return c.json(
        await reads.run(c.get('principal'), 'get', {
          kind,
          refs: input.ids,
          view: input.view ?? 'full',
          origin: originOf(c),
          ...(input.platform ? { platform: input.platform } : {}),
        }),
      )
    })
    app.get(`/${kind}/:id/metrics`, viewers, async (c) =>
      c.json(
        await reads.run(c.get('principal'), 'metrics', {
          kind,
          ref: c.req.param('id'),
          params: queries(c),
        }),
      ),
    )
    app.get(`/${kind}/:id`, viewers, async (c) => {
      const ref = c.req.param('id')
      const { items } = await reads.run(c.get('principal'), 'get', {
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
  app.get('/aggregate', viewers, async (c) =>
    c.json(
      await reads.run(c.get('principal'), 'aggregate', {
        params: queries(c),
      }),
    ),
  )
  app.get('/posts/:id/context', viewers, async (c) =>
    c.json(
      await reads.run(c.get('principal'), 'context', {
        id: c.req.param('id'),
        origin: originOf(c),
      }),
    ),
  )
  const accountRead =
    (name: 'history' | 'relations' | 'relationChanges') => async (c: Context) =>
      c.json(
        await reads.run(c.get('principal'), name, {
          ref: c.req.param('id')!,
          params: queries(c),
          origin: originOf(c),
        }),
      )
  app.get('/accounts/:id/history', viewers, accountRead('history'))
  app.get('/accounts/:id/relations', viewers, accountRead('relations'))
  app.get(
    '/accounts/:id/relation-changes',
    viewers,
    accountRead('relationChanges'),
  )

  // --- Folders, tags, captures --------------------------------------------
  app.get('/folders', viewers, async (c) =>
    c.json(await reads.run(c.get('principal'), 'folders', undefined)),
  )
  app.get('/tags', async (c) =>
    c.json(await reads.run(c.get('principal'), 'tags', undefined)),
  )
  app.get('/updates/:id', async (c) =>
    c.json(
      await reads.run(c.get('principal'), 'status', { id: c.req.param('id') }),
    ),
  )
  app.get('/jobs', async (c) =>
    c.json(await reads.run(c.get('principal'), 'queue', undefined)),
  )
  app.get('/watches', async (c) =>
    c.json(await reads.run(c.get('principal'), 'watches', {})),
  )
  app.get('/shares', async (c) => {
    const of = c.req.query('of')
    return c.json(
      await reads.run(c.get('principal'), 'shares', {
        ...(of ? { of } : {}),
        origin: o.webAppUrl ? new URL(o.webAppUrl).origin : originOf(c),
      }),
    )
  })
  app.get('/capture-accounts', async (c) =>
    c.json(await reads.run(c.get('principal'), 'captureAccounts', undefined)),
  )

  writeRoutes(app, { ctx, reader: o.reader, reads })

  app.all('*', () => {
    throw notFound('No such endpoint. See agent.md.')
  })
  return app
}
