import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import {
  createSession,
  deleteSession,
  initDataUser,
  SESSION_TTL,
  sessionValid,
  tokenValid,
  widgetUser,
} from './auth.ts'
import { errorResponse } from './errors.ts'
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

export type Env = { Variables: { session: boolean } }

/** Read and validate a JSON body. */
export async function body<T extends v.GenericSchema>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<v.InferOutput<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'invalid request' })
  }
  const result = v.safeParse(schema, raw)
  if (!result.success)
    throw new HTTPException(400, { message: 'invalid request' })
  return result.output
}

function origin(url: string | undefined): string | undefined {
  return url ? new URL(url).origin : undefined
}

/** The `/v1` API: Telegram login for the owner, sessions and tokens. */
export function createApi(options: HttpOptions): Hono<Env> {
  const { ctx } = options
  const now = options.now ?? Date.now
  const webOrigin = origin(options.webAppUrl)
  const app = new Hono<Env>()

  app.onError((error, c) => errorResponse(c, error, ctx.logger))
  app.use(async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  app.get('/auth/telegram', async (c) => {
    if (!options.telegram || !webOrigin || !options.botUsername)
      return c.json({ error: 'not found' }, 404)
    try {
      return c.json({ bot_username: await options.botUsername() })
    } catch {
      return c.json({ error: 'Telegram unavailable' }, 503)
    }
  })

  app.post('/auth/telegram', async (c) => {
    const telegram = options.telegram
    if (!telegram || !webOrigin) return c.json({ error: 'not found' }, 404)
    if (c.req.header('Origin') !== webOrigin)
      return c.json({ error: 'invalid origin' }, 403)
    const input = await body(
      c,
      v.union([
        v.strictObject({ init_data: v.pipe(v.string(), v.maxLength(16_384)) }),
        v.strictObject({ login: v.record(v.string(), v.unknown()) }),
      ]),
    )
    const user =
      'init_data' in input
        ? initDataUser(input.init_data, telegram.token, now())
        : widgetUser(input.login, telegram.token, now())
    if (!user)
      return c.json(
        {
          error:
            'init_data' in input
              ? 'reopen Telegram Mini App'
              : 'log in with Telegram again',
        },
        401,
      )
    if (user !== telegram.owner) return c.json({ error: 'not allowed' }, 403)
    setCookie(c, SESSION_COOKIE, createSession(ctx.db, now()), {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
      maxAge: SESSION_TTL,
    })
    return c.json({})
  })

  // Everything else needs a token or the owner's session.
  app.use(async (c, next) => {
    const header = c.req.header('Authorization')
    if (header !== undefined) {
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!token || !tokenValid(ctx.db, token))
        return c.json({ error: 'invalid session or token' }, 401)
      c.set('session', false)
      await next()
      return
    }
    const cookie = getCookie(c, SESSION_COOKIE)
    if (!cookie || !webOrigin)
      return c.json({ error: 'authentication required' }, 401)
    if (!sessionValid(ctx.db, cookie, now()))
      return c.json({ error: 'invalid session or token' }, 401)
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      c.req.header('Origin') !== webOrigin
    )
      return c.json({ error: 'invalid origin' }, 403)
    c.set('session', true)
    await next()
  })

  app.get('/session', (c) => c.json({}))
  app.delete('/session', (c) => {
    const cookie = getCookie(c, SESSION_COOKIE)
    if (cookie) deleteSession(ctx.db, cookie)
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true })
    return c.body(null, 204)
  })
  return app
}
