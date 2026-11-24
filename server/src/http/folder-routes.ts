import { Hono } from 'hono'
import * as v from 'valibot'
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from '#library/folders.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

/** Saved library filters (收藏夹). */
export function folderRoutes(ctx: AccountsContext) {
  return new Hono<Env>()
    .get('/folders', async (c) => c.json(await listFolders(ctx.db)))

    .post(
      '/folders',
      json(v.strictObject({ name: v.string(), filter: v.string() })),
      (c) => c.json(createFolder(ctx.db, c.req.valid('json'))),
    )

    .patch(
      '/folders/:id',
      json(
        v.strictObject({
          name: v.optional(v.string()),
          filter: v.optional(v.string()),
        }),
      ),
      (c) =>
        c.json(updateFolder(ctx.db, c.req.param('id'), c.req.valid('json'))),
    )

    .delete('/folders/:id', (c) => {
      deleteFolder(ctx.db, c.req.param('id'))
      return c.body(null, 204)
    })
}
