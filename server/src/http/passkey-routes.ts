import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import { startSession } from './auth.ts'
import {
  deletePasskey,
  listPasskeys,
  login,
  loginOptions,
  NAME_MAX,
  register,
  registrationOptions,
  renamePasskey,
  type PasskeyView,
} from './passkeys.ts'
import { rateLimit } from './rate-limit.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

export interface PasskeyOptions {
  ctx: AccountsContext
  /** The origins the web app is served on; a passkey is made on one. */
  webOrigins: string[]
  /** Tell the owner a passkey came or went. */
  notify?: (text: string) => void
  now: () => number
}

const TOKEN = v.pipe(v.string(), v.regex(/^[\w-]{43}$/))
const NAME = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(NAME_MAX))

// The library checks the fields in depth; this only keeps junk out.
const credential = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  (value as { id: string }).id.length <= 1024 &&
  typeof (value as { response?: unknown }).response === 'object'
const Registration = v.custom<RegistrationResponseJSON>(credential)
const Authentication = v.custom<AuthenticationResponseJSON>(credential)

const WINDOW = 60_000

/** The request's origin when it is one of the app's; refused otherwise. */
function originOf(c: Context, origins: string[]): string {
  const origin = c.req.header('Origin')
  if (!origin || !origins.includes(origin))
    throw new HTTPException(403, { message: '请求来源无效' })
  return origin
}

const describe = (p: PasskeyView) => `${p.name}（${p.rp_id}）`

/**
 * Signing in with a passkey, and making one from a /passkey link; both
 * work without a session.
 */
export function passkeyAuthRoutes(o: PasskeyOptions) {
  const { ctx } = o
  const limit = rateLimit({ perClient: 20, total: 60, windowMs: WINDOW })
  return new Hono<Env>()
    .use(limit)
    .post('/options', async (c) =>
      c.json(await loginOptions(ctx.db, originOf(c, o.webOrigins), o.now())),
    )
    .post(
      '/',
      json(v.strictObject({ response: Authentication })),
      async (c) => {
        const origin = originOf(c, o.webOrigins)
        await login(ctx.db, origin, c.req.valid('json').response, o.now())
        startSession(c, ctx.db, o.now())
        return c.body(null, 204)
      },
    )
    .post(
      '/register/options',
      json(v.strictObject({ token: TOKEN })),
      async (c) =>
        c.json(
          await registrationOptions(
            ctx.db,
            originOf(c, o.webOrigins),
            c.req.valid('json').token,
            o.now(),
          ),
        ),
    )
    .post(
      '/register',
      json(
        v.strictObject({ token: TOKEN, name: NAME, response: Registration }),
      ),
      async (c) => {
        const origin = originOf(c, o.webOrigins)
        const passkey = await register(
          ctx.db,
          origin,
          c.req.valid('json'),
          o.now(),
        )
        o.notify?.(`已添加通行密钥：${describe(passkey)}`)
        startSession(c, ctx.db, o.now())
        return c.json(passkey)
      },
    )
}

/** The owner's passkeys, signed in: list, add on this domain, rename, delete. */
export function passkeyRoutes(o: PasskeyOptions) {
  const { ctx } = o
  const limit = rateLimit({ perClient: 20, total: 60, windowMs: WINDOW })
  return new Hono<Env>()
    .get('/', (c) => c.json(listPasskeys(ctx.db)))
    .post('/options', limit, async (c) =>
      c.json(
        await registrationOptions(
          ctx.db,
          originOf(c, o.webOrigins),
          undefined,
          o.now(),
        ),
      ),
    )
    .post(
      '/',
      limit,
      json(v.strictObject({ name: NAME, response: Registration })),
      async (c) => {
        const passkey = await register(
          ctx.db,
          originOf(c, o.webOrigins),
          c.req.valid('json'),
          o.now(),
        )
        o.notify?.(`已添加通行密钥：${describe(passkey)}`)
        return c.json(passkey)
      },
    )
    .patch('/:id', json(v.strictObject({ name: NAME })), (c) => {
      const passkey = renamePasskey(
        ctx.db,
        c.req.param('id'),
        c.req.valid('json').name,
      )
      if (!passkey) return c.json({ error: '通行密钥不存在' }, 404)
      return c.json(passkey)
    })
    .delete('/:id', (c) => {
      const passkey = deletePasskey(ctx.db, c.req.param('id'))
      if (!passkey) return c.json({ error: '通行密钥不存在' }, 404)
      o.notify?.(`已删除通行密钥：${describe(passkey)}`)
      return c.body(null, 204)
    })
}
