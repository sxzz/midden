import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import * as v from 'valibot'
import { HEARTBEAT_TIMEOUT, setHeartbeatTimeoutMinutes } from '#settings.ts'
import { accountRoutes } from './account-routes.ts'
import {
  deleteSession,
  initDataUser,
  SESSION_COOKIE,
  sessionValid,
  startSession,
  tokenValid,
} from './auth.ts'
import { captureRoutes } from './capture-routes.ts'
import { Challenges } from './challenges.ts'
import { errorResponse } from './errors.ts'
import { folderRoutes } from './folder-routes.ts'
import { libraryRoutes } from './library-routes.ts'
import { mediaRoutes } from './media-routes.ts'
import { originRoutes } from './origin-routes.ts'
import { allowedOrigins } from './origins.ts'
import { passkeyAuthRoutes, passkeyRoutes } from './passkey-routes.ts'
import { publicRoutes } from './public-routes.ts'
import { queueRoutes, type QueueInfo } from './queue-routes.ts'
import { shareRoutes } from './share-routes.ts'
import { storageRoutes } from './storage-routes.ts'
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
}

/**
 * The `/v1` API: passkey or Mini App login for the owner, then everything
 * else behind a token or the owner's session. Its type is the web app's API
 * client.
 */
export function createApi(options: HttpOptions) {
  const { ctx } = options
  const now = options.now ?? Date.now
  const { webAppUrl } = options
  const origins = () => allowedOrigins(ctx.db, webAppUrl)
  const fromWeb = (origin: string | undefined) =>
    !!origin && origins().includes(origin)
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

  return (
    new Hono<Env>()
      .onError((error, c) => errorResponse(c, error, ctx.logger))
      .use(async (c, next) => {
        await next()
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
          startSession(c, ctx.db, now())
          return c.json({})
        },
      )
      .route('/auth/passkey', passkeyAuthRoutes(passkeys))
      // Public links need no login; they read only what was shared.
      .route('/public', publicRoutes(ctx))
      // Everything below needs a token or the owner's session.
      .use(async (c, next) => {
        const header = c.req.header('Authorization')
        if (header !== undefined) {
          const token = header.startsWith('Bearer ') ? header.slice(7) : ''
          if (!token || !tokenValid(ctx.db, token))
            return c.json({ error: '登录已失效或令牌无效' }, 401)
          c.set('session', false)
          await next()
          return
        }
        const cookie = getCookie(c, SESSION_COOKIE)
        if (!cookie) return c.json({ error: '需要登录' }, 401)
        if (!sessionValid(ctx.db, cookie, now()))
          return c.json({ error: '登录已失效或令牌无效' }, 401)
        if (
          !['GET', 'HEAD'].includes(c.req.method) &&
          !fromWeb(c.req.header('Origin'))
        )
          return c.json({ error: '请求来源无效' }, 403)
        c.set('session', true)
        await next()
      })
      // Answers only whether the request is signed in.
      .get('/session', (c) => c.body(null, 204))
      .delete('/session', (c) => {
        const cookie = getCookie(c, SESSION_COOKIE)
        if (cookie) deleteSession(ctx.db, cookie)
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true })
        return c.body(null, 204)
      })
      // What the web app shows only on a development server.
      .get('/instance', (c) =>
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
        queueRoutes(ctx.db, options.queue ?? { worker: () => undefined }),
      )
      .route('/', captureRoutes(ctx, { dev: !!options.dev }))
      .route('/', accountRoutes(ctx))
      .route('/', libraryRoutes(ctx))
      .route('/', folderRoutes(ctx))
      .route('/', watchRoutes(ctx))
      .route('/', shareRoutes(ctx))
      .route('/passkeys', passkeyRoutes(passkeys))
      .route(
        '/origins',
        originRoutes({ ctx, webAppUrl, notify: options.notify, now }),
      )
      .route('/', mediaRoutes(ctx))
  )
}

export type Api = ReturnType<typeof createApi>
