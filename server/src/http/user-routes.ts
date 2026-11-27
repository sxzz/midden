import { Hono } from 'hono'
import * as v from 'valibot'
import { createInvite, listInvites, revokeInvite } from '#users/invites.ts'
import { deleteUser, listUsers, renameUser, revokeUser } from '#users/users.ts'
import { adminSession } from './auth.ts'
import { inline } from './offload.ts'
import { json, type Env } from './validate.ts'
import type { Database } from '#db/client.ts'

/**
 * Where an invite's link points: the web app's `invite` page under
 * WEB_APP_URL, the one domain viewers use, the token in the fragment (never
 * sent to a server, never logged).
 */
export function inviteLink(webAppUrl: string, token: string): string {
  const app = new URL(webAppUrl)
  const base = app.pathname.endsWith('/') ? app.pathname : `${app.pathname}/`
  const url = new URL('invite', new URL(base, app.origin))
  url.hash = token
  return url.href
}

/**
 * 设置 → 管理员面板 → 用户: the users, renaming, revoking and deleting them,
 * and invites. The admin's web session alone, like tokens and sessions: a
 * token cannot make a link that registers.
 */
export function userRoutes(o: {
  db: Database
  webAppUrl?: string
  now: () => number
}) {
  const { db, now } = o
  const Name = v.strictObject({ name: v.pipe(v.string(), v.maxLength(256)) })
  const users = new Hono<Env>()
    .use(adminSession)
    // Small reads, here, so the guard refuses before any thread is taken.
    .get('/', inline, (c) => c.json(listUsers(db, now())))
    .patch('/:id', json(Name), (c) =>
      c.json(
        renameUser(db, c.req.param('id'), c.req.valid('json').name, now()),
      ),
    )
    // Their passkeys, sessions and tokens go; they stay listed, revoked.
    .post('/:id/revoke', (c) =>
      c.json(revokeUser(db, c.req.param('id'), now())),
    )
    .delete('/:id', (c) => {
      deleteUser(db, c.req.param('id'))
      return c.body(null, 204)
    })
  const invites = new Hono<Env>()
    .use(adminSession)
    .get('/', inline, (c) => c.json(listInvites(db, now())))
    // The link is shown this once.
    .post(
      '/',
      json(v.strictObject({ label: v.pipe(v.string(), v.maxLength(256)) })),
      (c) => {
        if (!o.webAppUrl)
          return c.json({ error: '服务器未配置 WEB_APP_URL' }, 404)
        const { invite, token } = createInvite(
          db,
          c.req.valid('json').label,
          now(),
        )
        return c.json({ invite, url: inviteLink(o.webAppUrl, token) })
      },
    )
    .delete('/:id', (c) => {
      if (!revokeInvite(db, c.req.param('id'), now()))
        return c.json({ error: '邀请不存在或已失效' }, 404)
      return c.body(null, 204)
    })
  return { users, invites }
}
