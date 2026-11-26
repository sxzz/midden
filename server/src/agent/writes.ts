// The agent API's writes, for `rw` tokens: capturing, updating, tags,
// notes, folders, and pausing background work. They run on the web
// process like the web app's own: each is a small transaction that at most
// enqueues jobs. Nothing deletes content: that is the owner's, in the web
// app, signed in (`ownerOnly` on /v1).
import { sql } from 'drizzle-orm'
import * as v from 'valibot'
import { OptionsBody, resolveOptions } from '#capture/options.ts'
import { captureURL } from '#capture/records.ts'
import { pauseUpdate, resumeUpdate, startUpdate } from '#capture/updates.ts'
import { editWatch, setWatch } from '#capture/watches.ts'
import { watchFrequencies } from '#db/schema.ts'
import { readJobControl, writeJobControl } from '#jobs/control.ts'
import { PAUSABLE_TYPES } from '#jobs/queue.ts'
import {
  addTag,
  ensureTag,
  removeTag,
  updateAnnotation,
  type Annotation,
} from '#library/annotations.ts'
import { createFolder, updateFolder, type Folder } from '#library/folders.ts'
import { isUUID } from '#library/read.ts'
import { renameTag } from '#library/tags.ts'
import { AgentError, invalid, notFound } from './errors.ts'
import { body, type AgentEnv } from './http.ts'
import {
  checkKeys,
  describe,
  filterOf,
  filterQueryString,
  findFolder,
  findTags,
  FOLDER_FILTER_KEYS,
  savedAccount,
  type AgentReader,
  type Kind,
  type Params,
} from './query.ts'
import { runRead } from './reads.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Reads } from './runner.ts'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { BlankSchema } from 'hono/types'

/** Writes need a read and write token. */
const writes: MiddlewareHandler<AgentEnv> = async (c, next) => {
  if (c.get('token').permission !== 'rw')
    throw new AgentError(
      'forbidden',
      'This token only reads. Writing needs a read and write (rw) token from the owner.',
    )
  await next()
}

/** A filter as an object of the search's parameters. */
const FilterBody = v.record(
  v.string(),
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.array(v.union([v.string(), v.number()])),
  ]),
)

function paramsOf(filter: v.InferOutput<typeof FilterBody>): Params {
  return Object.fromEntries(
    Object.entries(filter).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : [String(value)],
    ]),
  )
}

const SORTS = [
  'relevance',
  'published',
  'saved',
  'updated',
  'storage',
  'followers',
  'following',
]

/** A folder's filter from the API's terms to the library's query string. */
function folderFilter(r: AgentReader, raw: v.InferOutput<typeof FilterBody>) {
  const params = paramsOf(raw)
  checkKeys(params, [...FOLDER_FILTER_KEYS, 'sort', 'order'])
  const sort = params.sort?.[0]
  if (sort && !SORTS.includes(sort))
    throw invalid(`sort must be one of: ${SORTS.join(', ')}.`)
  return filterQueryString(filterOf(r, 'folder', params))
}

function folderJson(r: AgentReader, f: Folder) {
  const { filter } = findFolder(r.db, f.id)
  const kinds = (kind: Kind) =>
    Object.entries(f.types)
      .filter(([type]) => r.types[kind].includes(type))
      .reduce((sum, [, n]) => sum + n, 0)
  return {
    id: f.id,
    name: f.name,
    filter: {
      ...describe(r, filter),
      ...(filter.sort ? { sort: filter.sort } : {}),
      ...(filter.order ? { order: filter.order } : {}),
    },
    posts: kinds('posts'),
    accounts: kinds('accounts'),
    created_at: f.created_at,
    updated_at: f.updated_at,
  }
}

const annotationJson = (id: string, a: Annotation) => ({
  id,
  tags: a.tags,
  note: a.note,
})

const idempotencyKey = (c: Context) =>
  c.req.header('Idempotency-Key') || undefined

const statusUrl = (id: string) => `/agent/v1/updates/${id}`

/** A saved post's id, or not_found: also for an account's. */
function savedPost(r: AgentReader, ref: string): string {
  const id = isUUID(ref) ? ref.toLowerCase() : ''
  const found = id
    ? r.db.get<{ id: string }>(sql`
        SELECT k.collection_id AS id FROM catalog k
        JOIN library l ON l.collection_id = k.collection_id
        WHERE k.collection_id = ${id} AND coalesce(k.root_kind, '') NOT LIKE '%.profile'`)
    : undefined
  if (!found) throw notFound(`No saved post has the id ${ref}.`)
  return found.id
}

/** The writes, on the agent API's app. */
export function writeRoutes(
  app: Hono<AgentEnv, BlankSchema, '/agent/v1'>,
  o: { ctx: AccountsContext; reader: AgentReader; reads: Reads },
) {
  const { ctx, reader } = o
  const parse = body
  const target = (kind: Kind, ref: string, platform?: string) =>
    kind === 'posts'
      ? savedPost(reader, ref)
      : savedAccount(reader, ref, platform)

  // --- Capturing ----------------------------------------------------------
  app.post('/captures', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        url: v.pipe(v.string(), v.maxLength(8192)),
        options: v.optional(OptionsBody),
      }),
    )
    const job = captureURL(
      ctx,
      input.url,
      idempotencyKey(c),
      resolveOptions(input.options),
    )
    return c.json(
      {
        record_id: job.submissionId,
        collection_id: job.collectionId,
        state: job.state,
        status_url: statusUrl(job.submissionId),
      },
      202,
    )
  })

  app.post('/updates', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        target: v.union([
          v.strictObject({ post: v.string() }),
          v.strictObject({
            account: v.string(),
            platform: v.optional(v.string()),
          }),
          v.strictObject({ folder: v.string() }),
          v.strictObject({
            ids: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(500)),
          }),
        ]),
        options: v.optional(OptionsBody),
        older: v.optional(v.boolean()),
      }),
    )
    const t = input.target
    const id = startUpdate(
      ctx,
      'post' in t
        ? { target: 'collection', id: savedPost(reader, t.post) }
        : 'account' in t
          ? {
              target: 'collection',
              id: savedAccount(reader, t.account, t.platform),
            }
          : 'folder' in t
            ? { target: 'folder', id: findFolder(reader.db, t.folder).id }
            : { target: 'many', ids: t.ids.map((ref) => ref.toLowerCase()) },
      {
        options: resolveOptions(input.options),
        older: input.older,
        key: idempotencyKey(c),
      },
    )
    return c.json(
      {
        update_id: id,
        status_url: statusUrl(id),
        ...(runRead(reader, 'status', { id }) as object),
      },
      202,
    )
  })

  for (const op of ['pause', 'resume'] as const)
    app.post(`/updates/:id/${op}`, writes, (c) => {
      const id = c.req.param('id')
      if (!isUUID(id)) throw notFound()
      ;(op === 'pause' ? pauseUpdate : resumeUpdate)(ctx, id.toLowerCase())
      return c.json(runRead(reader, 'status', { id }))
    })

  // All background work, or some job types (管理员面板 → 后台任务).
  app.patch('/jobs', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        paused: v.optional(v.boolean()),
        paused_types: v.optional(v.array(v.picklist(PAUSABLE_TYPES))),
      }),
    )
    const control = readJobControl(ctx.db)
    writeJobControl(ctx.db, {
      paused: input.paused ?? control.paused,
      types: input.paused_types ?? control.types,
    })
    return c.json(runRead(reader, 'queue', {}))
  })

  // --- 定期更新 -----------------------------------------------------------
  // Watching an account or a folder: one watch per target, so a second
  // PUT changes it. Turning one off is `enabled: false`; deleting is the
  // owner's, in the web app.
  const watchOf = (id: string) => {
    const [watch] = (
      runRead(reader, 'watches', { id }) as {
        items: unknown[]
      }
    ).items
    if (!watch) throw notFound()
    return watch
  }
  app.put('/watches', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        target: v.union([
          v.strictObject({
            account: v.string(),
            platform: v.optional(v.string()),
          }),
          v.strictObject({ folder: v.string() }),
        ]),
        frequency: v.picklist(watchFrequencies),
        options: v.optional(OptionsBody),
      }),
    )
    const t = input.target
    const id = setWatch(
      ctx,
      'folder' in t
        ? { target: 'folder', id: findFolder(reader.db, t.folder).id }
        : {
            target: 'collection',
            id: savedAccount(reader, t.account, t.platform),
          },
      {
        frequency: input.frequency,
        options: resolveOptions(input.options),
      },
    )
    return c.json(watchOf(id))
  })
  app.patch('/watches/:id', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        frequency: v.optional(v.picklist(watchFrequencies)),
        options: v.optional(OptionsBody),
        enabled: v.optional(v.boolean()),
      }),
    )
    const id = c.req.param('id')
    if (!isUUID(id)) throw notFound()
    editWatch(ctx, id.toLowerCase(), {
      frequency: input.frequency,
      options: input.options && resolveOptions(input.options),
      enabled: input.enabled,
    })
    return c.json(watchOf(id.toLowerCase()))
  })

  // --- Tags -------------------------------------------------------------
  app.post('/tags', writes, async (c) => {
    const { name } = await parse(c, v.strictObject({ name: v.string() }))
    const tag = ctx.db.transaction((tx) => ensureTag(tx, name))
    return c.json(tag)
  })

  // Renaming to another tag's name merges the two.
  app.patch('/tags/:id', writes, async (c) => {
    const { name } = await parse(c, v.strictObject({ name: v.string() }))
    const [tag] = findTags(ctx.db, [c.req.param('id')])
    return c.json(renameTag(ctx.db, tag!.id, name))
  })

  app.post('/tags/:id/merge', writes, async (c) => {
    const { into } = await parse(c, v.strictObject({ into: v.string() }))
    const [from, to] = findTags(ctx.db, [c.req.param('id'), into])
    if (from!.id === to!.id) throw invalid('A tag cannot merge into itself.')
    return c.json(renameTag(ctx.db, from!.id, to!.name))
  })

  // --- Tags and notes on posts and accounts ---------------------------------
  for (const kind of ['posts', 'accounts'] as const) {
    app.post(`/${kind}/:id/tags`, writes, async (c) => {
      const { tag } = await parse(c, v.strictObject({ tag: v.string() }))
      const id = target(kind, c.req.param('id'), c.req.query('platform'))
      return c.json(
        annotationJson(
          id,
          addTag(
            ctx.db,
            id,
            isUUID(tag) ? { id: tag.toLowerCase() } : { name: tag },
          ),
        ),
      )
    })
    app.delete(`/${kind}/:id/tags/:tag`, writes, (c) => {
      const id = target(kind, c.req.param('id'), c.req.query('platform'))
      const [tag] = findTags(ctx.db, [c.req.param('tag')])
      return c.json(annotationJson(id, removeTag(ctx.db, id, tag!.id)))
    })
    app.put(`/${kind}/:id/note`, writes, async (c) => {
      const { note } = await parse(c, v.strictObject({ note: v.string() }))
      const id = target(kind, c.req.param('id'), c.req.query('platform'))
      return c.json(annotationJson(id, updateAnnotation(ctx.db, id, { note })))
    })
    app.delete(`/${kind}/:id/note`, writes, (c) => {
      const id = target(kind, c.req.param('id'), c.req.query('platform'))
      return c.json(
        annotationJson(id, updateAnnotation(ctx.db, id, { note: '' })),
      )
    })
  }

  // --- Folders ----------------------------------------------------------
  app.post('/folders', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({ name: v.string(), filter: FilterBody }),
    )
    const folder = createFolder(ctx.db, {
      name: input.name,
      filter: folderFilter(reader, input.filter),
    })
    return c.json(folderJson(reader, folder), 201)
  })

  app.patch('/folders/:id', writes, async (c) => {
    const input = await parse(
      c,
      v.strictObject({
        name: v.optional(v.string()),
        filter: v.optional(FilterBody),
      }),
    )
    const { id } = findFolder(ctx.db, c.req.param('id'))
    const folder = updateFolder(ctx.db, id, {
      name: input.name,
      filter: input.filter && folderFilter(reader, input.filter),
    })
    return c.json(folderJson(reader, folder))
  })
}
