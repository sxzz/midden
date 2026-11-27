import { Hono } from 'hono'
import * as v from 'valibot'
import {
  previewRemoval,
  REMOVAL_MAX,
  removeMedia,
} from '#library/media-removal.ts'
import { restoreMedia } from '#library/media-restore.ts'
import {
  latestVideoRemoval,
  previewVideoRemoval,
  startVideoRemoval,
} from '#library/video-removal.ts'
import { ownerOnly } from './auth.ts'
import { readOnly, type NamedRead } from './offload.ts'
import { json, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

/** Every media item of some collections, or one item of one collection. */
const Target = v.union([
  v.strictObject({
    ids: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(REMOVAL_MAX)),
  }),
  v.strictObject({ collection: v.string(), asset: v.string() }),
])

const Item = v.strictObject({ collection: v.string(), asset: v.string() })

/** Removing media to save space (删除媒体) and taking it back (恢复). */
export function mediaRoutes(ctx: AccountsContext, read: NamedRead) {
  return (
    new Hono<Env>()
      // The dry run the confirmation states its effect from.
      .post('/media-removals/preview', readOnly, json(Target), (c) =>
        c.json(previewRemoval(ctx, c.req.valid('json'))),
      )
      // Planned on a read thread, then written a batch at a time.
      .post('/media-removals', ownerOnly, json(Target), async (c) => {
        const target = c.req.valid('json')
        const plan = await read('removalPlan', target)
        return c.json(await removeMedia(ctx, target, { plan }))
      })
      // Linked back at once, or the download job that brings it back.
      .post('/media-removals/restore', json(Item), async (c) => {
        const input = c.req.valid('json')
        return c.json(await restoreMedia(ctx, input.collection, input.asset))
      })
      // 删除所有视频 of a profile: the dry run, the job, and the newest one
      // to follow while it runs.
      .post('/collections/:id/video-removal/preview', readOnly, (c) =>
        c.json(previewVideoRemoval(ctx, c.req.param('id'))),
      )
      .post('/collections/:id/video-removal', ownerOnly, (c) =>
        c.json(startVideoRemoval(ctx, c.req.param('id')), 202),
      )
      .get('/collections/:id/video-removal', (c) => {
        const removal = latestVideoRemoval(ctx.db, c.req.param('id'))
        return c.json({ ...(removal ? { removal } : {}) })
      })
  )
}
