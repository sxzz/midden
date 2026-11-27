import { Hono } from 'hono'
import * as v from 'valibot'
import { countWrittenFolder } from '#library/folder-counts.ts'
import {
  createFolder,
  deleteFolder,
  folderView,
  listFolders,
  updateFolder,
} from '#library/folders.ts'
import { ownerOnly } from './auth.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { WebReads } from './offload.ts'

/**
 * Saved library filters (收藏夹). The list answers the counts the worker
 * stored (`library/folder-counts.ts`); a folder made or given a new filter
 * is counted once on a read thread before the write answers.
 */
export function folderRoutes(ctx: AccountsContext, reads?: WebReads) {
  const counted = async (id: string) => {
    await countWrittenFolder(ctx.db, id, reads?.countFolder, ctx.logger)
    return folderView(ctx.db, id)
  }
  return new Hono<Env>()
    .get('/folders', (c) => c.json(listFolders(ctx.db)))

    .post(
      '/folders',
      json(v.strictObject({ name: v.string(), filter: v.string() })),
      async (c) =>
        c.json(await counted(createFolder(ctx.db, c.req.valid('json')).id)),
    )

    .patch(
      '/folders/:id',
      json(
        v.strictObject({
          name: v.optional(v.string()),
          filter: v.optional(v.string()),
        }),
      ),
      async (c) => {
        const input = c.req.valid('json')
        const folder = updateFolder(ctx.db, c.req.param('id'), input)
        return c.json(
          input.filter === undefined ? folder : await counted(folder.id),
        )
      },
    )

    .delete('/folders/:id', ownerOnly, (c) => {
      deleteFolder(ctx.db, c.req.param('id'))
      return c.body(null, 204)
    })
}
