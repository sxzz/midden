import { Buffer } from 'node:buffer'
import * as v from 'valibot'
import {
  addAccount,
  checkAccount,
  listAccounts,
  revokeAccount,
  selectAccount,
  type AccountsContext,
} from '#accounts/accounts.ts'
import {
  listTags,
  readAnnotation,
  updateAnnotation,
} from '#library/annotations.ts'
import { deleteCollection } from '#library/delete.ts'
import { body, type Env } from './app.ts'
import type { Hono } from 'hono'

export function accountRoutes(app: Hono<Env>, ctx: AccountsContext): void {
  app.get('/accounts', (c) => {
    const { platforms, accounts } = listAccounts(ctx)
    return c.json({
      platforms: platforms.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.help ? { help: p.help } : {}),
        public: p.public,
        can_add: p.canAdd,
        ...(p.selected ? { selected_account_id: p.selected } : {}),
      })),
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.username ? { username: a.username } : {}),
        state: a.state,
        platform: a.platform,
        selected: a.selected,
      })),
    })
  })

  app.post('/accounts', async (c) => {
    const input = await body(
      c,
      v.strictObject({
        platform: v.string(),
        credential: v.pipe(v.string(), v.maxLength(65_536)),
        name: v.optional(v.string()),
      }),
    )
    const account = await addAccount(ctx, input.platform, {
      credential: Buffer.from(input.credential),
      name: input.name,
    })
    return c.json(account)
  })

  app.put('/accounts/selection', async (c) => {
    const input = await body(
      c,
      v.strictObject({ platform: v.string(), account_id: v.string() }),
    )
    selectAccount(ctx, input.platform, input.account_id)
    return c.body(null, 204)
  })

  app.post('/accounts/:id/check', async (c) => {
    await checkAccount(ctx, c.req.param('id'))
    return c.body(null, 204)
  })

  app.delete('/accounts/:id', (c) => {
    revokeAccount(ctx, c.req.param('id'))
    return c.body(null, 204)
  })

  app.get('/tags', (c) => c.json(listTags(ctx.db)))

  app.get('/collections/:id/annotation', (c) =>
    c.json(readAnnotation(ctx.db, c.req.param('id'))),
  )

  app.patch('/collections/:id/annotation', async (c) => {
    const input = await body(
      c,
      v.strictObject({
        note: v.optional(v.string()),
        tag_ids: v.optional(v.array(v.string())),
        tag_names: v.optional(v.array(v.string())),
      }),
    )
    return c.json(
      updateAnnotation(ctx.db, c.req.param('id'), {
        note: input.note,
        tagIds: input.tag_ids,
        tagNames: input.tag_names,
      }),
    )
  })

  app.delete('/collections/:id', (c) => {
    deleteCollection(ctx.db, c.req.param('id'))
    return c.body(null, 204)
  })

  // Space used by what is stored; there is no quota.
  app.get('/usage', (c) => {
    const row = ctx.db.$client
      .prepare(
        `SELECT
           (SELECT coalesce(sum(size), 0) FROM blobs)
           + (SELECT coalesce(sum(content_bytes), 0) FROM revisions)
           + (SELECT coalesce(sum(size), 0) FROM source_responses) AS used`,
      )
      .get() as { used: number | bigint }
    const used = Number(row.used)
    return c.json({
      used_bytes: used,
      reserved_bytes: 0,
      limit_bytes: 0,
      unlimited: true,
    })
  })
}
