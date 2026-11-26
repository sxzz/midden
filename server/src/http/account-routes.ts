import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
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
import { deleteCollection, deleteCollections } from '#library/delete.ts'
import { storageUsed } from '#library/read.ts'
import { deleteTag, renameTag } from '#library/tags.ts'
import { ownerOnly } from './auth.ts'
import { json, type Env } from './validate.ts'

const accountJson = (
  a: ReturnType<typeof listAccounts>['accounts'][number],
) => ({
  id: a.id,
  name: a.name,
  ...(a.username ? { username: a.username } : {}),
  state: a.state,
  platform: a.platform,
  selected: a.selected,
})

export function accountRoutes(ctx: AccountsContext) {
  const accounts = () => {
    const { platforms, accounts } = listAccounts(ctx)
    return {
      platforms: platforms.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.help ? { help: p.help } : {}),
        public: p.public,
        can_add: p.canAdd,
        ...(p.selected ? { selected_account_id: p.selected } : {}),
      })),
      accounts: accounts.map(accountJson),
    }
  }

  return new Hono<Env>()
    .get('/accounts', (c) => c.json(accounts()))

    .post(
      '/accounts',
      json(
        v.strictObject({
          platform: v.string(),
          credential: v.pipe(v.string(), v.maxLength(65_536)),
          name: v.optional(v.string()),
        }),
      ),
      async (c) => {
        const input = c.req.valid('json')
        const { id } = await addAccount(ctx, input.platform, {
          credential: Buffer.from(input.credential),
          name: input.name,
        })
        // The web app names the account it just added from this response.
        const account = listAccounts(ctx).accounts.find((a) => a.id === id)!
        return c.json(accountJson(account))
      },
    )

    .put(
      '/accounts/selection',
      json(v.strictObject({ platform: v.string(), account_id: v.string() })),
      (c) => {
        const input = c.req.valid('json')
        selectAccount(ctx, input.platform, input.account_id)
        return c.json(accounts())
      },
    )

    .post('/accounts/:id/check', async (c) => {
      await checkAccount(ctx, c.req.param('id'))
      return c.body(null, 204)
    })

    .delete('/accounts/:id', ownerOnly, (c) => {
      revokeAccount(ctx, c.req.param('id'))
      return c.body(null, 204)
    })

    .get('/tags', (c) => c.json(listTags(ctx.db)))

    .patch('/tags/:id', json(v.strictObject({ name: v.string() })), (c) =>
      c.json(renameTag(ctx.db, c.req.param('id'), c.req.valid('json').name)),
    )

    .delete('/tags/:id', ownerOnly, (c) => {
      deleteTag(ctx.db, c.req.param('id'))
      return c.body(null, 204)
    })

    .get('/collections/:id/annotation', (c) =>
      c.json(readAnnotation(ctx.db, c.req.param('id'))),
    )

    .patch(
      '/collections/:id/annotation',
      json(
        v.strictObject({
          note: v.optional(v.string()),
          tag_ids: v.optional(v.array(v.string())),
          tag_names: v.optional(v.array(v.string())),
        }),
      ),
      (c) => {
        const input = c.req.valid('json')
        return c.json(
          updateAnnotation(ctx.db, c.req.param('id'), {
            note: input.note,
            tagIds: input.tag_ids,
            tagNames: input.tag_names,
          }),
        )
      },
    )

    .delete('/collections/:id', ownerOnly, (c) => {
      deleteCollection(ctx.db, c.req.param('id'))
      return c.body(null, 204)
    })

    .post(
      '/collections/delete',
      ownerOnly,
      json(
        v.strictObject({
          ids: v.pipe(v.array(v.string()), v.minLength(1)),
          with_posts: v.optional(v.boolean()),
          dry_run: v.optional(v.boolean()),
        }),
      ),
      (c) => {
        const input = c.req.valid('json')
        return c.json(
          deleteCollections(ctx.db, input.ids, {
            withPosts: input.with_posts,
            dryRun: input.dry_run,
          }),
        )
      },
    )

    .get('/usage', (c) => c.json({ used_bytes: storageUsed(ctx.db) }))
}
