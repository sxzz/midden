import { Hono } from 'hono'
import * as v from 'valibot'
import {
  createToken,
  listTokens,
  PERMISSIONS,
  revokeToken,
  rollToken,
  updateToken,
  type TokenView,
} from '#tokens/tokens.ts'
import { adminId } from '#users/users.ts'
import { ownerOnly } from './auth.ts'
import { inline } from './offload.ts'
import { json, type Env } from './validate.ts'
import type { Database } from '#db/client.ts'
import type { TokenUsage } from '#tokens/usage.ts'

/** An ISO time, or null for never; tokens.ts checks it is ahead. */
const Expiry = v.nullable(
  v.pipe(
    v.string(),
    v.isoTimestamp(),
    v.transform((value) => new Date(value)),
  ),
)

/**
 * 设置 → API 令牌: the owner's tokens, with when each was last used and its
 * requests over the last 30 days. Only a web session manages them.
 */
export function tokenRoutes(
  db: Database,
  usage: TokenUsage,
  now: () => number,
) {
  // Usage not flushed yet counts too: the page shows the request just made.
  const withUsage = (tokens: TokenView[]) => {
    const summaries = usage.summaries(
      db,
      tokens.map((t) => t.id),
    )
    return tokens.map((token) => {
      const last = Math.max(
        usage.lastUsed(token.id) ?? 0,
        Date.parse(token.last_used_at ?? '') || 0,
      )
      return {
        ...token,
        last_used_at: last ? new Date(last).toISOString() : null,
        usage: summaries.get(token.id)!,
      }
    })
  }
  return (
    new Hono<Env>()
      .use(ownerOnly)
      // Usage not written yet is in this process's memory.
      .get('/', inline, (c) => c.json(withUsage(listTokens(db, now()))))
      .post(
        '/',
        json(
          v.strictObject({
            label: v.string(),
            permission: v.picklist(PERMISSIONS),
            expires_at: Expiry,
          }),
        ),
        (c) => {
          const input = c.req.valid('json')
          const issued = createToken(
            db,
            {
              user: adminId(db),
              label: input.label,
              permission: input.permission,
              expiresAt: input.expires_at,
            },
            now(),
          )
          return c.json({
            token: withUsage([issued.token])[0]!,
            secret: issued.secret,
          })
        },
      )
      .patch(
        '/:id',
        json(
          v.strictObject({
            label: v.optional(v.string()),
            expires_at: v.optional(Expiry),
          }),
        ),
        (c) => {
          const input = c.req.valid('json')
          const token = updateToken(
            db,
            c.req.param('id'),
            { label: input.label, expiresAt: input.expires_at },
            now(),
          )
          return c.json(withUsage([token])[0]!)
        },
      )
      // A new secret for the same token; the old one stops working now.
      .post('/:id/roll', (c) => {
        const issued = rollToken(db, c.req.param('id'), now())
        return c.json({
          token: withUsage([issued.token])[0]!,
          secret: issued.secret,
        })
      })
      .get('/:id/usage', inline, (c) => {
        const id = c.req.param('id')
        const [token] = withUsage(
          listTokens(db, now()).filter((t) => t.id === id),
        )
        if (!token) return c.json({ error: '令牌不存在' }, 404)
        return c.json({
          days: token.usage.days,
          endpoints: usage.endpoints(db, id),
        })
      })
      .delete('/:id', (c) => {
        revokeToken(db, c.req.param('id'))
        return c.body(null, 204)
      })
  )
}
