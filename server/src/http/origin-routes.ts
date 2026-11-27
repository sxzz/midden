import { Hono } from 'hono'
import * as v from 'valibot'
import { ownerOnly } from './auth.ts'
import { addOrigin, listOrigins, removeOrigin } from './origins.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const hostOf = (origin: string) => new URL(origin).host

/**
 * The web app's domains, signed in: list, add, remove. Adding and removing
 * are the web session's alone (`ownerOnly`): a domain is where cookie
 * sessions write from (SameSite=None, so the Origin check is what stops
 * another site) and where passkeys are made and /passkey links point.
 */
export function originRoutes(o: {
  ctx: AccountsContext
  webAppUrl?: string
  notify?: (text: string) => void
  now: () => number
}) {
  const { db } = o.ctx
  return new Hono<Env>()
    .get('/', (c) => c.json(listOrigins(db, o.webAppUrl)))
    .post(
      '/',
      ownerOnly,
      json(v.strictObject({ origin: v.pipe(v.string(), v.maxLength(2048)) })),
      (c) => {
        const added = addOrigin(
          db,
          o.webAppUrl,
          c.req.valid('json').origin,
          o.now(),
        )
        o.notify?.(`已添加域名：${hostOf(added.origin)}`)
        return c.json(added)
      },
    )
    .delete('/:id', ownerOnly, (c) => {
      const removed = removeOrigin(db, o.webAppUrl, c.req.param('id'))
      if (!removed) return c.json({ error: '域名不存在' }, 404)
      o.notify?.(
        removed.passkeys > 0
          ? `已删除域名：${hostOf(removed.origin)}，同时删除了 ${removed.passkeys} 个通行密钥`
          : `已删除域名：${hostOf(removed.origin)}`,
      )
      return c.json({ passkeys: removed.passkeys })
    })
}
