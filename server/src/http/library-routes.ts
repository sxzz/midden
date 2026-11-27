import { Hono } from 'hono'
import * as v from 'valibot'
import { bothExtras } from '#agent/query.ts'
import { AppError } from '#errors.ts'
import { aggregateList } from '#agent/aggregate.ts'
import { authorTerms } from '#library/author-terms.ts'
import { CHANGES_WINDOW, listProfileChanges } from '#library/changes.ts'
import { compareRelations, compareSides } from '#library/compare.ts'
import { selectionCounts, type Selection } from '#library/counts.ts'
import { getEntity } from '#library/entities.ts'
import { collectionFilter, FilterQuery } from '#library/filter-query.ts'
import { visibleFolder } from '#library/folders.ts'
import {
  accountGraph,
  followGraph,
  GRAPH_MAX,
  graphKinds,
  type GraphKind,
} from '#library/follow-graph.ts'
import {
  FOLLOW_CHANGES_LIMIT,
  followCounts,
  listFollowChanges,
} from '#library/follows.ts'
import { listAuthors, listCollections } from '#library/list.ts'
import { listPerspectives } from '#library/perspectives.ts'
import {
  COUNTS_LIMIT,
  getCollection,
  getHistoryPoint,
  listCounts,
  listHistory,
} from '#library/read.ts'
import { suggest, SUGGEST_KINDS } from '#library/suggest.ts'
import { OWNER_LIMITS } from '#query/ast.ts'
import { compileQuery } from '#query/compile.ts'
import { sees } from '#users/principal.ts'
import { readCtx, viewers } from './auth.ts'
import { Cursor, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { ReadContext } from '#library/views.ts'

const text = v.optional(v.string())

/** The list's filters, and a folder it starts from (`folder=<id>`). */
const ListFilters = v.object({ ...FilterQuery.entries, folder: text })
/** ... and the page to read. */
const Filters = v.object({ ...ListFilters.entries, cursor: text })

/** The list's filters, and what to count its posts by. */
const AggregateQuery = v.object({
  ...FilterQuery.entries,
  by: v.string(),
  limit: text,
})

const AuthorFilters = v.object({
  q: text,
  cursor: text,
  author: v.optional(v.union([v.string(), v.array(v.string())])),
})

const PerspectiveFilters = v.object({
  q: text,
  cursor: text,
  rel_of: v.optional(v.union([v.string(), v.array(v.string())])),
})

/** How many of the newest readings to return, at most COUNTS_LIMIT. */
export const CountsQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,4}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(COUNTS_LIMIT),
    ),
  ),
})

/** How many of the newest profile changes to return. */
export const ChangesQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,4}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(CHANGES_WINDOW),
    ),
  ),
})

/** How many of the newest follow changes to return. */
export const FollowChangesQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,4}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(FOLLOW_CHANGES_LIMIT),
    ),
  ),
})

/**
 * Which kinds of accounts a follow graph shows, comma-separated (all when
 * absent), and how many of them at most.
 */
export const GraphQuery = v.object({
  kinds: v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => (value ? value.split(',') : [])),
      v.array(v.picklist(graphKinds)),
      v.transform((kinds): GraphKind[] => [...new Set(kinds)]),
    ),
  ),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,5}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(GRAPH_MAX),
    ),
  ),
})

/** The owner's graph may be seen from an account (`viewer`). */
const OwnGraphQuery = v.object({ ...GraphQuery.entries, viewer: text })
/** The graph of any account with relation data, by its key (`of`). */
const AccountGraphQuery = v.object({
  ...OwnGraphQuery.entries,
  of: v.pipe(v.string(), v.nonEmpty()),
})

const count = (max: number, digits: number) =>
  v.pipe(
    v.string(),
    v.regex(new RegExp(String.raw`^[1-9]\d{0,${digits - 1}}$`)),
    v.transform(Number),
    v.maxValue(max),
  )

/**
 * The accounts to compare (`rel_of`, repeated, in the order shown), the
 * side (`rel`), how many of them an account must relate to (`rel_min`),
 * an exact subset as indexes (`only`, comma-separated) and how many
 * accounts to return.
 */
export const CompareQuery = v.object({
  rel_of: v.pipe(
    v.union([v.string(), v.array(v.string())]),
    v.transform((value) => (typeof value === 'string' ? [value] : value)),
  ),
  rel: v.optional(v.picklist(compareSides)),
  rel_min: v.optional(count(1_000_000, 7)),
  only: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^(?:0|[1-9]\d{0,6})(?:,(?:0|[1-9]\d{0,6}))*$/),
      v.transform((value) => value.split(',').map(Number)),
    ),
  ),
  limit: v.optional(count(GRAPH_MAX, 5)),
  viewer: text,
})

/**
 * What a list request selects: its filters, a folder it starts from
 * (`folder=<id>`: the folder's query holds and the rest only narrows it,
 * as the agent API's `folder`), and its `q`, a query of the query
 * language (the owner's limits) adding to them. Read in the sight of who
 * asks: a viewer has no tags, so a tag parameter is refused whether the
 * tag exists or not, and only a publicly shared folder is found; a folder's
 * own query is the admin's, compiled as theirs.
 */
function listQuery(
  r: ReadContext,
  input: v.InferOutput<typeof ListFilters>,
): Selection {
  if (!sees(r.principal).tags && (input.tag || input.tag_mode || input.not_tag))
    throw new AppError('invalid_filter')
  const own = collectionFilter({ ...input, q: undefined })
  const types = r.platforms.types()
  const timeZone = own.timeZone ? { timeZone: own.timeZone } : {}
  const folder = input.folder ? visibleFolder(r, input.folder) : undefined
  if (input.folder && !folder) throw new AppError('not_found', '收藏夹不存在')
  const inFolder = folder
    ? compileQuery(`folder:${folder.id}`, {
        db: r.db,
        types,
        principal: r.principal,
        kind: 'all',
        filter: own,
        scoped: true,
        limits: OWNER_LIMITS,
        prefix: 'folder',
        ...timeZone,
      })
    : undefined
  const base = inFolder?.filter ?? own
  const compiled = input.q?.trim()
    ? compileQuery(input.q, {
        db: r.db,
        types,
        principal: r.principal,
        kind: 'all',
        filter: base,
        scoped: true,
        limits: OWNER_LIMITS,
        ...timeZone,
      })
    : undefined
  const extra = bothExtras(inFolder?.extra, compiled?.extra)
  return {
    filter: {
      ...(compiled?.filter ?? base),
      // The folder's order unless the request gives one.
      ...(folder && !own.sort && folder.sort ? { sort: folder.sort } : {}),
      ...(folder && !own.order && folder.order ? { order: folder.order } : {}),
    },
    ...(extra ? { extra } : {}),
  }
}

/** Reading the library: collections, their history, and entities. */
export function libraryRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      .get('/collections', viewers, query(Filters), (c) => {
        const input = c.req.valid('query')
        const { filter, extra } = listQuery(readCtx(ctx, c), input)
        return c.json(
          listCollections(
            ctx,
            filter,
            input.cursor || undefined,
            undefined,
            undefined,
            extra,
          ),
        )
      })

      // Cached like the folders' counts; the web asks before splitting a
      // folder into post and account tabs.
      .get('/collections/count', viewers, query(ListFilters), (c) =>
        c.json(
          selectionCounts(
            ctx.db,
            listQuery(readCtx(ctx, c), c.req.valid('query')),
          ),
        ),
      )

      // What the query box offers for the value being typed.
      .get(
        '/query/suggest',
        viewers,
        query(v.object({ kind: v.picklist(SUGGEST_KINDS), prefix: text })),
        (c) => {
          const { kind, prefix } = c.req.valid('query')
          return c.json({ items: suggest(readCtx(ctx, c), kind, prefix) })
        },
      )

      // What the list holds, in buckets (the agent API's aggregate over the
      // list's own filter): the library's sidebar shows the top hashtags
      // and authors of the list beside it.
      .get('/collections/aggregate', query(AggregateQuery), (c) => {
        const { by, limit, ...input } = c.req.valid('query')
        return c.json(
          aggregateList(ctx.db, collectionFilter(input), { by, limit }),
        )
      })

      // Each with the term the query box writes for it (`from:@alice`)
      // when one names it alone.
      .get('/collections/authors', viewers, query(AuthorFilters), (c) => {
        const input = c.req.valid('query')
        const author = input.author ?? []
        const page = listAuthors(ctx, {
          q: input.q || undefined,
          cursor: input.cursor || undefined,
          authors: typeof author === 'string' ? [author] : author,
        })
        const terms = authorTerms(
          ctx.db,
          ctx.platforms.types(),
          page.items.map((a) => a.id),
        )
        return c.json({
          ...page,
          items: page.items.map((a) => ({ ...a, term: terms.get(a.id) })),
        })
      })

      // Accounts the 「关系」 filter can look from; signed in only, since it
      // names accounts no share reaches.
      .get(
        '/collections/perspectives',
        viewers,
        query(PerspectiveFilters),
        (c) => {
          const input = c.req.valid('query')
          return c.json(
            listPerspectives(readCtx(ctx, c), {
              q: input.q || undefined,
              cursor: input.cursor || undefined,
              relOf:
                typeof input.rel_of === 'string'
                  ? [input.rel_of]
                  : input.rel_of,
            }),
          )
        },
      )

      // Several accounts' follows side by side; owner only, like the
      // perspectives it compares.
      .get('/collections/compare', viewers, query(CompareQuery), (c) => {
        const input = c.req.valid('query')
        return c.json(
          compareRelations(readCtx(ctx, c), {
            relOf: input.rel_of,
            rel: input.rel,
            min: input.rel_min,
            only: input.only,
            limit: input.limit,
            viewer: input.viewer || undefined,
          }),
        )
      })

      // 关系 opens on an account, saved or not; owner only, like the
      // perspectives it is picked from.
      .get('/collections/graph', viewers, query(AccountGraphQuery), (c) => {
        const { of, viewer, ...input } = c.req.valid('query')
        return c.json(
          accountGraph(readCtx(ctx, c), of, {
            ...input,
            viewer: viewer || undefined,
          }),
        )
      })

      .get('/collections/:id', viewers, (c) =>
        c.json(getCollection(ctx, c.req.param('id'))),
      )

      .get('/collections/:id/history', viewers, query(Cursor), (c) =>
        c.json(
          listHistory(
            ctx,
            c.req.param('id'),
            c.req.valid('query').cursor || undefined,
          ),
        ),
      )

      .get('/collections/:id/counts', viewers, query(CountsQuery), (c) =>
        c.json(listCounts(ctx, c.req.param('id'), c.req.valid('query').limit)),
      )

      .get(
        '/collections/:id/profile-changes',
        viewers,
        query(ChangesQuery),
        (c) =>
          c.json(
            listProfileChanges(
              ctx,
              c.req.param('id'),
              c.req.valid('query').limit,
            ),
          ),
      )

      .get('/collections/:id/follows', viewers, (c) =>
        c.json(followCounts(ctx, c.req.param('id'))),
      )

      .get(
        '/collections/:id/follow-changes',
        viewers,
        query(FollowChangesQuery),
        (c) =>
          c.json(
            listFollowChanges(
              ctx,
              c.req.param('id'),
              c.req.valid('query').limit,
            ),
          ),
      )

      .get('/collections/:id/graph', viewers, query(OwnGraphQuery), (c) =>
        c.json(
          followGraph(readCtx(ctx, c), c.req.param('id'), {
            ...c.req.valid('query'),
            viewer: c.req.valid('query').viewer || undefined,
          }),
        ),
      )

      .get('/collections/:id/history/:capture', viewers, (c) =>
        c.json(getHistoryPoint(ctx, c.req.param('id'), c.req.param('capture'))),
      )

      .get('/entities/:id', viewers, (c) =>
        c.json(getEntity(ctx, c.req.param('id'))),
      )
  )
}
