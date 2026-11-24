import { Hono } from 'hono'
import * as v from 'valibot'
import { createShare, listShares, revokeShare } from '#library/shares.ts'
import { json, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

/** The owner's public links (分享). */
export function shareRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      // With `collection`, only the links that make it public.
      .get(
        '/shares',
        query(v.object({ collection: v.optional(v.string()) })),
        (c) => c.json(listShares(ctx.db, c.req.valid('query').collection)),
      )

      .post(
        '/shares',
        json(
          v.strictObject({
            target: v.picklist(['folder', 'collection']),
            id: v.string(),
          }),
        ),
        (c) => c.json(createShare(ctx.db, c.req.valid('json'))),
      )

      .delete('/shares/:id', (c) => {
        revokeShare(ctx.db, c.req.param('id'))
        return c.body(null, 204)
      })
  )
}
