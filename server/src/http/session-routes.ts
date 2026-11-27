import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { sessionOnly, viewers } from './auth.ts'
import { inline } from './offload.ts'
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
  SESSION_COOKIE,
} from './sessions.ts'
import type { Database } from '#db/client.ts'
import type { Env } from './validate.ts'

/**
 * 设置 → 通行密钥 → 已登录的设备: the browsers a user signed in, and signing
 * them out. Each user's own, viewers' too; only a web session sees or ends
 * sessions, no API token does.
 */
export function sessionRoutes(db: Database, now: () => number) {
  return (
    new Hono<Env>()
      .use(sessionOnly)
      // Which one is this request's: the cookie stays in this process.
      .get('/', inline, viewers, (c) =>
        c.json(
          listSessions(
            db,
            c.get('principal').userId,
            c.get('sessionId'),
            now(),
          ),
        ),
      )
      .post('/revoke-others', viewers, (c) =>
        c.json({
          revoked: revokeOtherSessions(
            db,
            c.get('principal').userId,
            c.get('sessionId'),
          ),
        }),
      )
      .delete('/:id', viewers, (c) => {
        const id = c.req.param('id')
        if (!revokeSession(db, c.get('principal').userId, id))
          return c.json({ error: '会话不存在' }, 404)
        if (id === c.get('sessionId'))
          deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true })
        return c.body(null, 204)
      })
  )
}
