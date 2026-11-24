import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import * as v from 'valibot'
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
import { errorResponse } from './errors.ts'
import { folderRoutes } from './folder-routes.ts'
import { libraryRoutes } from './library-routes.ts'
import { passkeyAuthRoutes, passkeyRoutes } from './passkey-routes.ts'
import { publicRoutes } from './public-routes.ts'
import { shareRoutes } from './share-routes.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

export { SESSION_COOKIE }

export interface HttpOptions {
  ctx: AccountsContext
  telegram?: { token: string; owner: string }
  /**
   * The origins the web app is served on. Cookie sessions write only from
   * these, and passkeys are made and used only on them.
   */
  webOrigins?: string[]
  /** Tell the owner, through the bot, that a passkey came or went. */
  notify?: (text: string) => void
  now?: () => number
}

/**
 * The `/v1` API: passkey or Mini App login for the owner, then everything
 * else behind a token or the owner's session. Its type is the web app's API
 * client.
 */
export function createApi(options: HttpOptions) {
  const { ctx } = options
  const now = options.now ?? Date.now
  const webOrigins = options.webOrigins ?? []
  const fromWeb = (origin: string | undefined) =>
    !!origin && webOrigins.includes(origin)
  const passkeys = {
    ctx,
    webOrigins,
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
          if (!telegram || webOrigins.length === 0)
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
        if (!cookie || webOrigins.length === 0)
          return c.json({ error: '需要登录' }, 401)
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
      .route('/', captureRoutes(ctx))
      .route('/', accountRoutes(ctx))
      .route('/', libraryRoutes(ctx))
      .route('/', folderRoutes(ctx))
      .route('/', shareRoutes(ctx))
      .route('/passkeys', passkeyRoutes(passkeys))
  )
}

export type Api = ReturnType<typeof createApi>
