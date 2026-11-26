import { Hono } from 'hono'
import * as v from 'valibot'
import { OptionsBody, optionsJson, resolveOptions } from '#capture/options.ts'
import {
  deleteWatch,
  editWatch,
  listWatches,
  setWatch,
  type WatchView,
} from '#capture/watches.ts'
import { watchFrequencies } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { json, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const Target = v.picklist(['collection', 'folder'])
const Frequency = v.picklist(watchFrequencies)

function watchJson(w: WatchView) {
  return {
    id: w.id,
    target: w.target,
    target_id: w.targetId,
    ...(w.name ? { name: w.name } : {}),
    ...(w.handle ? { handle: w.handle } : {}),
    ...(w.url ? { url: w.url } : {}),
    frequency: w.frequency,
    options: optionsJson(w.options),
    enabled: w.enabled,
    next_run_at: w.nextRunAt.toISOString(),
    ...(w.error ? { error: w.error } : {}),
    created_at: w.createdAt.toISOString(),
    ...(w.lastRun
      ? {
          last_run: {
            id: w.lastRun.id,
            state: w.lastRun.state,
            done: w.lastRun.done,
            ...(w.lastRun.paused ? { paused: true } : {}),
            ...(w.lastRun.stopped ? { stopped: true } : {}),
            created_at: w.lastRun.createdAt.toISOString(),
          },
        }
      : {}),
  }
}

/** 定期更新: watches of saved profiles and folders. */
export function watchRoutes(ctx: AccountsContext) {
  const one = (id: string) => {
    const [found] = listWatches(ctx.db, { id })
    if (!found) throw new AppError('not_found')
    return watchJson(found)
  }
  return (
    new Hono<Env>()
      // All watches, or the one of a target (none or one item).
      .get(
        '/watches',
        query(
          v.object({ target: v.optional(Target), id: v.optional(v.string()) }),
        ),
        (c) => {
          const q = c.req.valid('query')
          const target =
            q.target && q.id ? { target: q.target, id: q.id } : undefined
          return c.json({
            items: listWatches(ctx.db, { target }).map(watchJson),
          })
        },
      )

      // Watch a target, or change its watch: one per target.
      .put(
        '/watches',
        json(
          v.strictObject({
            target: Target,
            id: v.string(),
            frequency: Frequency,
            options: v.optional(OptionsBody),
          }),
        ),
        (c) => {
          const body = c.req.valid('json')
          const id = setWatch(
            ctx,
            { target: body.target, id: body.id },
            {
              frequency: body.frequency,
              options: resolveOptions(body.options),
            },
          )
          return c.json(one(id))
        },
      )

      .patch(
        '/watches/:id',
        json(
          v.strictObject({
            frequency: v.optional(Frequency),
            options: v.optional(OptionsBody),
            enabled: v.optional(v.boolean()),
          }),
        ),
        (c) => {
          const body = c.req.valid('json')
          const id = c.req.param('id')
          editWatch(ctx, id, {
            frequency: body.frequency,
            options: body.options && resolveOptions(body.options),
            enabled: body.enabled,
          })
          return c.json(one(id))
        },
      )

      .delete('/watches/:id', (c) => {
        deleteWatch(ctx.db, c.req.param('id'))
        return c.body(null, 204)
      })
  )
}
