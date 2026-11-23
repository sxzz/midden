import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import * as v from 'valibot'
import { accountRoutes } from './account-routes.ts'
import {
  createSession,
  deleteSession,
  initDataUser,
  SESSION_TTL,
  sessionValid,
  tokenValid,
  widgetUser,
} from './auth.ts'
import { captureRoutes } from './capture-routes.ts'
import { errorResponse } from './errors.ts'
import { libraryRoutes } from './library-routes.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

export const SESSION_COOKIE = '__Host-midden'

export interface HttpOptions {
  ctx: AccountsContext
  telegram?: { token: string; owner: string }
  /** Public web app URL; cookie sessions work only when it is set. */
  webAppUrl?: string
  /** Look up the bot's username for the login widget. */
  botUsername?: () => Promise<string>
  now?: () => number
}

function origin(url: string | undefined): string | undefined {
  return url ? new URL(url).origin : undefined
}

/**
 * The `/v1` API: Telegram login for the owner, then everything else behind a
 * token or the owner's session. Its type is the web app's API client.
 */
export function createApi(options: HttpOptions) {
  const { ctx } = options
  const now = options.now ?? Date.now
  const webOrigin = origin(options.webAppUrl)

  return (
    new Hono<Env>()
      .onError((error, c) => errorResponse(c, error, ctx.logger))
      .use(async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
      })
      .get('/auth/telegram', async (c) => {
        if (!options.telegram || !webOrigin || !options.botUsername)
          return c.json({ error: '服务器未配置 Telegram 登录' }, 404)
        try {
          return c.json({ bot_username: await options.botUsername() })
        } catch {
          return c.json({ error: 'Telegram 暂时不可用，请稍后重试' }, 503)
        }
      })
      .post(
        '/auth/telegram',
        json(
          v.union([
            v.strictObject({
              init_data: v.pipe(v.string(), v.maxLength(16_384)),
            }),
            v.strictObject({ login: v.record(v.string(), v.unknown()) }),
          ]),
        ),
        (c) => {
          const telegram = options.telegram
          if (!telegram || !webOrigin)
            return c.json({ error: '服务器未配置 Telegram 登录' }, 404)
          if (c.req.header('Origin') !== webOrigin)
            return c.json({ error: '请求来源无效' }, 403)
          const input = c.req.valid('json')
          const user =
            'init_data' in input
              ? initDataUser(input.init_data, telegram.token, now())
              : widgetUser(input.login, telegram.token, now())
          if (!user)
            return c.json(
              {
                error:
                  'init_data' in input
                    ? '会话已失效，请从 Telegram 重新打开'
                    : 'Telegram 登录校验失败，请重试',
              },
              401,
            )
          if (user !== telegram.owner)
            return c.json({ error: '只有所有者可以登录' }, 403)
          setCookie(c, SESSION_COOKIE, createSession(ctx.db, now()), {
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'None',
            maxAge: SESSION_TTL,
          })
          return c.json({})
        },
      )
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
        if (!cookie || !webOrigin) return c.json({ error: '需要登录' }, 401)
        if (!sessionValid(ctx.db, cookie, now()))
          return c.json({ error: '登录已失效或令牌无效' }, 401)
        if (
          !['GET', 'HEAD'].includes(c.req.method) &&
          c.req.header('Origin') !== webOrigin
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
  )
}

export type Api = ReturnType<typeof createApi>
