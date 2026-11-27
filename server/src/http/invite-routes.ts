import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import { openInvite, useInvite } from '#users/invites.ts'
import { createViewer, NAME_MAX, userView } from '#users/users.ts'
import { NAME as PasskeyName, Registration, TOKEN } from './passkey-routes.ts'
import {
  creationOptions,
  keepPasskey,
  verifyCreation,
  type PasskeyStore,
} from './passkeys.ts'
import { createSession, setSessionCookie } from './sessions.ts'
import { json, type Env } from './validate.ts'

const GONE = '邀请链接已失效'

const Username = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(NAME_MAX),
)

const digestOf = (token: string) =>
  createHash('sha256').update(token).digest('hex')

/** What binds an invite's challenge: it answers for no other invite or link. */
const bindingOf = (digest: string) => `invite:${digest}`

/**
 * Registering with an invite (`/app/invite#<token>`), without a session:
 * the options, then the registration, which makes a viewer with the
 * invite's WebAuthn handle, keeps their passkey and signs them in, in one
 * transaction that uses the invite up. Only on WEB_APP_URL's origin, the one
 * domain viewers use. Whatever is wrong (expired, used, revoked, another
 * origin) is the same 403: nothing tells one from another. The bot says
 * nothing of it.
 */
export function inviteAuthRoutes(o: {
  store: PasskeyStore
  webAppUrl?: string
  now: () => number
}) {
  const { store, now } = o
  const { db } = store
  const originOf = (c: Context) => {
    const origin = c.req.header('Origin')
    if (!o.webAppUrl || origin !== new URL(o.webAppUrl).origin)
      throw new HTTPException(403, { message: GONE })
    return origin
  }
  return (
    new Hono<Env>()
      // `name`: what the account picker shows; the invite's label if none.
      .post(
        '/options',
        json(v.strictObject({ token: TOKEN, name: v.optional(Username) })),
        async (c) => {
          const origin = originOf(c)
          const input = c.req.valid('json')
          const invite = openInvite(db, input.token, now())
          if (!invite) throw new HTTPException(403, { message: GONE })
          return c.json(
            await creationOptions(
              store,
              origin,
              // Nobody yet, so nothing of theirs to exclude.
              {
                id: '',
                webauthnId: invite.webauthnId,
                name: input.name ?? invite.label,
              },
              bindingOf(invite.digest),
              now(),
            ),
          )
        },
      )
      .post(
        '/',
        json(
          v.strictObject({
            token: TOKEN,
            name: Username,
            passkey_name: PasskeyName,
            response: Registration,
          }),
        ),
        async (c) => {
          const origin = originOf(c)
          const input = c.req.valid('json')
          const digest = digestOf(input.token)
          if (!openInvite(db, input.token, now()))
            throw new HTTPException(403, { message: GONE })
          const credential = await verifyCreation(
            store,
            origin,
            bindingOf(digest),
            input.response,
            now(),
          )
          const at = now()
          const { user, cookie } = db.transaction((tx) => {
            // Read again here: another registration may have used it.
            const invite = openInvite(tx, input.token, at)
            if (!invite) throw new HTTPException(403, { message: GONE })
            const id = createViewer(
              tx,
              { name: input.name, webauthnId: invite.webauthnId },
              at,
            )
            if (!useInvite(tx, digest, id, at))
              throw new HTTPException(403, { message: GONE })
            keepPasskey(
              tx,
              { user: id, origin, name: input.passkey_name, credential },
              at,
            )
            return {
              user: userView(tx, id),
              cookie: createSession(
                tx,
                id,
                {
                  method: 'passkey',
                  origin,
                  userAgent: c.req.header('User-Agent'),
                },
                at,
              ),
            }
          })
          setSessionCookie(c, cookie)
          return c.json({ user })
        },
      )
  )
}
