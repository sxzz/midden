import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import * as v from 'valibot'
import { typeCatalog } from '#agent/runner.ts'
import { HEARTBEAT_TIMEOUT, setHeartbeatTimeoutMinutes } from '#settings.ts'
import { authenticate, bearer } from '#tokens/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { abilities } from '#users/principal.ts'
import { adminId, setNickname, userView } from '#users/users.ts'
import { accountRoutes } from './account-routes.ts'
import {
  endpointOf,
  initDataUser,
  NOT_FOR_VIEWERS,
  openToViewers,
  sessionOnly,
  viewers,
} from './auth.ts'
import { captureRoutes } from './capture-routes.ts'
import { Challenges } from './challenges.ts'
import { errorResponse } from './errors.ts'
import { folderRoutes } from './folder-routes.ts'
import { inviteAuthRoutes } from './invite-routes.ts'
import { libraryRoutes } from './library-routes.ts'
import { mediaRoutes } from './media-routes.ts'
import {
  inline,
  namedReads,
  offload,
  onlyReads,
  type ForwardedRequest,
  type WebReads,
} from './offload.ts'
import { originRoutes } from './origin-routes.ts'
import { allowedOrigins } from './origins.ts'
import { passkeyAuthRoutes, passkeyRoutes } from './passkey-routes.ts'
import { publicRoutes } from './public-routes.ts'
import { queueRoutes, type QueueInfo } from './queue-routes.ts'
import { sessionRoutes } from './session-routes.ts'
import {
  checkSession,
  deleteSession,
  replaceMiniAppSession,
  SESSION_COOKIE,
  setSessionCookie,
  type SessionStart,
} from './sessions.ts'
import { shareRoutes } from './share-routes.ts'
import { storageRoutes } from './storage-routes.ts'
import { tokenRoutes } from './token-routes.ts'
import { userRoutes } from './user-routes.ts'
import { json, type Env } from './validate.ts'
import { watchRoutes } from './watch-routes.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { LitestreamWatch } from '#litestream.ts'
import type { BotState } from '#telegram/launch.ts'
import type { StorageUsage } from '#usage/storage.ts'
import type { Buffer } from 'node:buffer'

export { SESSION_COOKIE }

export interface HttpOptions {
  ctx: AccountsContext
  telegram?: { token: string; owner: string }
  /**
   * The Mini App's address. Its origin and the ones added on the web are
   * where cookie sessions write from and passkeys are made and used.
   */
  webAppUrl?: string
  /** Signs WebAuthn challenges; derived from SECRET_KEY. */
  challengeKey?: Buffer
  /** Seals invite tokens at rest; derived from SECRET_KEY. */
  inviteKey?: Buffer
  /** Tell the owner, through the bot, that a passkey or domain came or went. */
  notify?: (text: string) => void
  now?: () => number
  /** Development mode, where deleting everything is allowed. */
  dev?: boolean
  /** Present when Litestream replicates the database. */
  litestream?: LitestreamWatch
  /** The Telegram bot's state; absent without a bot. */
  botState?: () => BotState
  /** 存储用量; the routes answer 404 without it. */
  storage?: StorageUsage
  /** 后台任务: the worker's and this process's state. */
  queue?: QueueInfo
  /** Counts requests per API token; one is made when absent (tests). */
  tokenUsage?: TokenUsage
  /**
   * Where `GET` requests and dry runs run, and what writes read first
   * (`offload.ts`): the read threads in the web process; in place when
   * absent (tests, and the threads themselves).
   */
  reads?: WebReads
  /**
   * On a read thread: requests come from the web process, which checked
   * the login and passes what it found (`forwarded` in the request's env).
   */
  trusted?: boolean
  /** After every request that may have written (not a `GET` or dry run). */
  onWrite?: () => void
}

/** What a read thread's API finds in each request's env. */
export interface ForwardedEnv {
  forwarded: Pick<ForwardedRequest, 'principal' | 'token'>
}

/**
 * The `/v1` API: passkey or Mini App login, then everything else behind a
 * token or a user's web session. Its type is the web app's API client.
 * `GET` requests run on the read threads (`offload.ts`) unless their route
 * says `inline`, and so do dry runs whose route says `readOnly`. Viewers
 * reach only the routes that say `viewers`, and only with their session:
 * their tokens are for the agent API.
 */
export function createApi(options: HttpOptions) {
  const { ctx } = options
  const now = options.now ?? Date.now
  const usage = options.tokenUsage ?? new TokenUsage({ db: ctx.db, now })
  const { webAppUrl } = options
  const origins = () => allowedOrigins(ctx.db, webAppUrl)
  const fromWeb = (origin: string | undefined) =>
    !!origin && origins().includes(origin)
  const toThreads = offload(options.reads)
  // What writes read first or answer with: on the threads, or here.
  const read = namedReads(options.reads, () => ({
    db: ctx.db,
    blobs: ctx.blobs,
    types: typeCatalog(ctx.platforms),
  }))
  const passkeys = {
    ctx,
    store: {
      db: ctx.db,
      challenges: new Challenges(options.challengeKey ?? randomBytes(32)),
    },
    origins,
    notify: options.notify,
    now,
  }
  const admin = userRoutes({
    db: ctx.db,
    webAppUrl,
    // Without one (tests), links made by this process show only in it.
    inviteKey: options.inviteKey ?? randomBytes(32),
    now,
  })

  // The web app calls from its own origins, with the session cookie. A
  // preflight is answered here, before any login check, and cached.
  const crossOrigin = cors({
    origin: (origin) => (fromWeb(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: CORS_MAX_AGE,
  })

  return (
    new Hono<Env>()
      .onError((error, c) => errorResponse(c, error, ctx.logger))
      .use((c, next) => {
        if (options.trusted) return next()
        const origin = c.req.header('Origin')
        if (origin && fromWeb(origin)) return crossOrigin(c, next)
        // Any other origin gets no CORS headers at all, not even
        // Allow-Credentials (Hono's cors sets that for every origin).
        c.header('Vary', 'Origin', { append: true })
        return next()
      })
      .use(async (c, next) => {
        try {
          await next()
        } finally {
          // What the read threads keep may be out of date now.
          if (!onlyReads(c)) options.onWrite?.()
        }
        c.header('Cache-Control', 'no-store')
      })
      // The Mini App signs in with the launch data Telegram signed.
      .post(
        '/auth/telegram',
        json(
          v.strictObject({
            init_data: v.pipe(v.string(), v.maxLength(16_384)),
          }),
        ),
        (c) => {
          const telegram = options.telegram
          if (!telegram || !webAppUrl)
            return c.json({ error: '服务器未配置 Telegram 登录' }, 404)
          if (!fromWeb(c.req.header('Origin')))
            return c.json({ error: '请求来源无效' }, 403)
          const user = initDataUser(
            c.req.valid('json').init_data,
            telegram.token,
            now(),
          )
          if (!user)
            return c.json({ error: '会话已失效，请从 Telegram 重新打开' }, 401)
          if (user !== telegram.owner)
            return c.json({ error: '只有所有者可以登录' }, 403)
          const start: SessionStart = {
            method: 'telegram',
            origin: c.req.header('Origin')!,
            userAgent: c.req.header('User-Agent'),
          }
          // The Mini App is the admin's alone. One Mini App session per
          // domain and device, however often it signs in again.
          setSessionCookie(
            c,
            replaceMiniAppSession(
              ctx.db,
              adminId(ctx.db),
              start,
              getCookie(c, SESSION_COOKIE),
              now(),
            ),
          )
          return c.json({})
        },
      )
      .route('/auth/passkey', passkeyAuthRoutes(passkeys))
      // A friend's invite registers them as a viewer.
      .route(
        '/auth/invite',
        inviteAuthRoutes({ store: passkeys.store, webAppUrl, now }),
      )
      // Public links need no login; they read only what was shared.
      .use('/public/*', toThreads)
      .route('/public', publicRoutes(ctx))
      // Everything below needs a token or a user's session.
      .use(async (c, next) => {
        if (options.trusted) {
          const { forwarded } = (c.env ?? {}) as Partial<ForwardedEnv>
          if (!forwarded) return c.json({ error: '需要登录' }, 401)
          c.set('principal', forwarded.principal)
          if (forwarded.token) c.set('token', forwarded.token)
          // Checked again here: the same app, so nothing to keep in step.
          if (!openToViewers(c)) return c.json({ error: NOT_FOR_VIEWERS }, 403)
          return next()
        }
        const header = c.req.header('Authorization')
        if (header !== undefined) {
          const auth = authenticate(ctx.db, bearer(header), now())
          if (!auth.ok)
            return c.json(
              {
                error:
                  auth.error === 'token_expired'
                    ? '令牌已过期'
                    : '登录已失效或令牌无效',
              },
              401,
            )
          const { token } = auth
          // A viewer's tokens are for the agent API alone: /v1 is the web
          // app's own API, and only the agent API is filtered for scripts.
          if (token.role !== 'admin') {
            usage.record(token.id, endpointOf(c))
            return c.json({ error: '这个令牌只能用于 Agent API' }, 403)
          }
          if (token.permission === 'ro' && !onlyReads(c)) {
            usage.record(token.id, endpointOf(c))
            return c.json({ error: '只读令牌不能修改内容' }, 403)
          }
          // A token is never a session, so it cannot delete, nor make or
          // change a token, session, passkey or domain (`adminSession`,
          // `sessionOnly`): it can never become a session. The one
          // exception is a development server, whose local proxy signs the
          // web app in with the admin's token: there their read and write
          // token stands in for their session. Production
          // (NODE_ENV=production) never does this.
          c.set('principal', {
            userId: token.userId,
            role: token.role,
            via: options.dev && token.permission === 'rw' ? 'session' : 'token',
            permission: token.permission,
          })
          c.set('token', token)
          try {
            await next()
          } finally {
            usage.record(token.id, endpointOf(c))
          }
          return
        }
        const cookie = getCookie(c, SESSION_COOKIE)
        if (!cookie) return c.json({ error: '需要登录' }, 401)
        const session = checkSession(ctx.db, cookie, now())
        if (!session) return c.json({ error: '登录已失效或令牌无效' }, 401)
        if (!READS.has(c.req.method) && !fromWeb(c.req.header('Origin')))
          return c.json({ error: '请求来源无效' }, 403)
        c.set('principal', {
          userId: session.userId,
          role: session.role,
          via: 'session',
        })
        c.set('sessionId', session.id)
        // Before the read threads: a refused request takes none.
        if (!openToViewers(c)) return c.json({ error: NOT_FOR_VIEWERS }, 403)
        await next()
        // Renewed: the browser keeps the cookie as long as the server. Set
        // on the response made (which may come from a read thread), unless
        // the request signed this session out.
        const ended = c.res.headers
          .getSetCookie()
          .some((line) => line.startsWith(`${SESSION_COOKIE}=`))
        if (session.renewed && !ended) setSessionCookie(c, cookie)
      })
      .use(toThreads)
      // Who is signed in, and what the web app offers them (`can`); the
      // server still decides each request.
      .get('/session', inline, viewers, (c) => {
        const principal = c.get('principal')
        return c.json({
          user: userView(ctx.db, principal.userId),
          can: abilities(principal),
        })
      })
      // Their own nickname, the admin's too; a viewer's session can.
      .patch(
        '/session',
        sessionOnly,
        viewers,
        json(v.strictObject({ name: v.pipe(v.string(), v.maxLength(256)) })),
        (c) => {
          const principal = c.get('principal')
          return c.json({
            user: setNickname(
              ctx.db,
              principal.userId,
              c.req.valid('json').name,
            ),
            can: abilities(principal),
          })
        },
      )
      .delete('/session', viewers, (c) => {
        const cookie = getCookie(c, SESSION_COOKIE)
        if (cookie) deleteSession(ctx.db, cookie)
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true })
        return c.body(null, 204)
      })
      // What the web app shows only on a development server. This process's
      // own state: it stays here.
      .get('/instance', inline, (c) =>
        c.json({
          dev: !!options.dev,
          bot: options.botState?.() ?? ('off' as const),
          litestream: options.litestream?.status() ?? {
            enabled: false,
            last_heartbeat_at: null,
            stale: false,
            stale_after_minutes: null,
          },
        }),
      )
      .put(
        '/instance/litestream',
        json(
          v.strictObject({
            stale_after_minutes: v.pipe(
              v.number(),
              v.integer(),
              v.minValue(HEARTBEAT_TIMEOUT.min),
              v.maxValue(HEARTBEAT_TIMEOUT.max),
            ),
          }),
        ),
        (c) => {
          const litestream = options.litestream
          if (!litestream)
            return c.json({ error: '服务器未配置 Litestream' }, 404)
          setHeartbeatTimeoutMinutes(
            ctx.db,
            c.req.valid('json').stale_after_minutes,
          )
          return c.json(litestream.status())
        },
      )
      .route('/storage', storageRoutes(options.storage))
      .route(
        '/queue',
        queueRoutes(
          ctx.db,
          options.queue ?? { worker: () => undefined },
          ctx.now,
        ),
      )
      .route('/', captureRoutes(ctx, read, { dev: !!options.dev }))
      .route('/', accountRoutes(ctx, read))
      .route('/', libraryRoutes(ctx))
      .route('/', folderRoutes(ctx, read))
      .route('/', watchRoutes(ctx))
      .route('/', shareRoutes(ctx))
      .route('/passkeys', passkeyRoutes(passkeys))
      .route('/tokens', tokenRoutes(ctx.db, usage, now))
      .route('/sessions', sessionRoutes(ctx.db, now))
      .route('/users', admin.users)
      .route('/invites', admin.invites)
      .route(
        '/origins',
        originRoutes({ ctx, webAppUrl, notify: options.notify, now }),
      )
      .route('/', mediaRoutes(ctx, read))
  )
}

export type Api = ReturnType<typeof createApi>

const READS = new Set(['GET', 'HEAD'])
/** Seconds a browser keeps a preflight's answer. */
const CORS_MAX_AGE = 7200
