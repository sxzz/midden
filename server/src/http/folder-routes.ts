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
import type { NamedRead } from './offload.ts'

/**
 * A folder's query (or a list filter, written as the query that says the
 * same), its order and the zone its relative dates count in.
 */
const FolderBody = {
  query: v.optional(v.string()),
  filter: v.optional(v.string()),
  sort: v.optional(v.string()),
  order: v.optional(v.string()),
  tz: v.optional(v.string()),
}

/**
 * Saved queries (收藏夹). The list answers the counts the worker stored
 * (`library/folder-counts.ts`); a folder made or given a new query is
 * counted once on a read thread before the write answers.
 */
export function folderRoutes(ctx: AccountsContext, read: NamedRead) {
  const types = () => ctx.platforms.types()
  const counted = async (id: string) => {
    await countWrittenFolder(
      ctx.db,
      id,
      (folderId) => read('folderCounts', { id: folderId }),
      ctx.logger,
      types(),
    )
    return folderView(ctx.db, id, types())
  }
  return new Hono<Env>()
    .get('/folders', (c) => c.json(listFolders(ctx.db, types())))

    .post(
      '/folders',
      // A new folder says what it holds, as a query or a list filter.
      json(
        v.pipe(
          v.strictObject({ name: v.string(), ...FolderBody }),
          v.check((b) => b.query !== undefined || b.filter !== undefined),
        ),
      ),
      async (c) =>
        c.json(
          await counted(createFolder(ctx.db, c.req.valid('json'), types()).id),
        ),
    )

    .patch(
      '/folders/:id',
      json(v.strictObject({ name: v.optional(v.string()), ...FolderBody })),
      async (c) => {
        const input = c.req.valid('json')
        const folder = updateFolder(ctx.db, c.req.param('id'), input, types())
        const changed = [input.query, input.filter, input.tz].some(
          (x) => x !== undefined,
        )
        return c.json(changed ? await counted(folder.id) : folder)
      },
    )

    .delete('/folders/:id', ownerOnly, (c) => {
      deleteFolder(ctx.db, c.req.param('id'))
      return c.body(null, 204)
    })
}
