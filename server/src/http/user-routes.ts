import { Hono } from 'hono'
import * as v from 'valibot'
import {
  createInvite,
  listInvites,
  regenerateInvite,
  revokeInvite,
} from '#users/invites.ts'
import { deleteUser, listUsers, revokeUser, setNote } from '#users/users.ts'
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
 * 设置 → 管理员面板 → 用户: the users, the admin's notes on them, revoking
 * and deleting them, and invites. The admin's web session alone, like
 * tokens and sessions: a token cannot make a link that registers.
 */
export function userRoutes(o: {
  db: Database
  webAppUrl?: string
  /** Seals invite tokens; derived from SECRET_KEY. */
  inviteKey: Uint8Array
  now: () => number
}) {
  const { db, now, inviteKey } = o
  const Text = v.pipe(v.string(), v.maxLength(256))
  const link = (token: string | null) =>
    token && o.webAppUrl ? inviteLink(o.webAppUrl, token) : null
  const users = new Hono<Env>()
    .use(adminSession)
    // Small reads, here, so the guard refuses before any thread is taken.
    .get('/', inline, (c) => c.json(listUsers(db, now())))
    // The admin's note; the nickname is the user's own (`PATCH /session`).
    .patch('/:id', json(v.strictObject({ note: Text })), (c) =>
      c.json(setNote(db, c.req.param('id'), c.req.valid('json').note, now())),
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
    // Here too: only this process has the key. `url` is null for an
    // invite whose token was not kept; making it again gives one.
    .get('/', inline, (c) =>
      c.json(
        listInvites(db, inviteKey, now()).map(({ token, ...invite }) => ({
          ...invite,
          url: link(token),
        })),
      ),
    )
    .post('/', json(v.strictObject({ label: Text })), (c) => {
      if (!o.webAppUrl)
        return c.json({ error: '服务器未配置 WEB_APP_URL' }, 404)
      const { invite, token } = createInvite(
        db,
        inviteKey,
        c.req.valid('json').label,
        now(),
      )
      return c.json({ invite, url: inviteLink(o.webAppUrl, token) })
    })
    // A new link for the same invite, good for 7 days from now; the old
    // one stops working at once.
    .post('/:id/regenerate', (c) => {
      if (!o.webAppUrl)
        return c.json({ error: '服务器未配置 WEB_APP_URL' }, 404)
      const made = regenerateInvite(db, inviteKey, c.req.param('id'), now())
      if (!made) return c.json({ error: '邀请不存在或已失效' }, 404)
      return c.json({
        invite: made.invite,
        url: inviteLink(o.webAppUrl, made.token),
      })
    })
    .delete('/:id', (c) => {
      if (!revokeInvite(db, c.req.param('id'), now()))
        return c.json({ error: '邀请不存在或已失效' }, 404)
      return c.body(null, 204)
    })
  return { users, invites }
}
