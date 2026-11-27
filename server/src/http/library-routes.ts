import { Hono } from 'hono'
import * as v from 'valibot'
import { authorTerms } from '#library/author-terms.ts'
import { CHANGES_WINDOW, listProfileChanges } from '#library/changes.ts'
import { compareRelations, compareSides } from '#library/compare.ts'
import { selectionCounts, type Selection } from '#library/counts.ts'
import { getEntity } from '#library/entities.ts'
import {
  collectionFilter,
  FilterQuery,
  type FilterParams,
} from '#library/filter-query.ts'
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
import { readCtx } from './auth.ts'
import { Cursor, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const text = v.optional(v.string())

/** The list's filters and the page to read. */
const Filters = v.object({ ...FilterQuery.entries, cursor: text })

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
 * What a list request selects: its filters, and its `q`, a query of the
 * query language (the owner's limits) adding to them.
 */
function listQuery(ctx: AccountsContext, input: FilterParams): Selection {
  const filter = collectionFilter({ ...input, q: undefined })
  const compiled = input.q?.trim()
    ? compileQuery(input.q, {
        db: ctx.db,
        types: ctx.platforms.types(),
        kind: 'all',
        filter,
        scoped: true,
        limits: OWNER_LIMITS,
        ...(filter.timeZone ? { timeZone: filter.timeZone } : {}),
      })
    : undefined
  return compiled
    ? {
        filter: compiled.filter,
        ...(compiled.extra ? { extra: compiled.extra } : {}),
      }
    : { filter }
}

/** Reading the library: collections, their history, and entities. */
export function libraryRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      .get('/collections', query(Filters), (c) => {
        const input = c.req.valid('query')
        const { filter, extra } = listQuery(ctx, input)
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
      .get('/collections/count', query(FilterQuery), (c) =>
        c.json(selectionCounts(ctx.db, listQuery(ctx, c.req.valid('query')))),
      )

      // What the query box offers for the value being typed.
      .get(
        '/query/suggest',
        query(v.object({ kind: v.picklist(SUGGEST_KINDS), prefix: text })),
        (c) => {
          const { kind, prefix } = c.req.valid('query')
          return c.json({ items: suggest(ctx.db, kind, prefix) })
        },
      )

      // Each with the term the query box writes for it (`from:@alice`)
      // when one names it alone.
      .get('/collections/authors', query(AuthorFilters), (c) => {
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

      // Accounts the 「关系」 filter can look from; owner only, since it
      // names accounts no share reaches.
      .get('/collections/perspectives', query(PerspectiveFilters), (c) => {
        const input = c.req.valid('query')
        return c.json(
          listPerspectives(ctx, {
            q: input.q || undefined,
            cursor: input.cursor || undefined,
            relOf:
              typeof input.rel_of === 'string' ? [input.rel_of] : input.rel_of,
          }),
        )
      })

      // Several accounts' follows side by side; owner only, like the
      // perspectives it compares.
      .get('/collections/compare', query(CompareQuery), (c) => {
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
      .get('/collections/graph', query(AccountGraphQuery), (c) => {
        const { of, viewer, ...input } = c.req.valid('query')
        return c.json(
          accountGraph(readCtx(ctx, c), of, {
            ...input,
            viewer: viewer || undefined,
          }),
        )
      })

      .get('/collections/:id', (c) =>
        c.json(getCollection(ctx, c.req.param('id'))),
      )

      .get('/collections/:id/history', query(Cursor), (c) =>
        c.json(
          listHistory(
            ctx,
            c.req.param('id'),
            c.req.valid('query').cursor || undefined,
          ),
        ),
      )

      .get('/collections/:id/counts', query(CountsQuery), (c) =>
        c.json(listCounts(ctx, c.req.param('id'), c.req.valid('query').limit)),
      )

      .get('/collections/:id/profile-changes', query(ChangesQuery), (c) =>
        c.json(
          listProfileChanges(
            ctx,
            c.req.param('id'),
            c.req.valid('query').limit,
          ),
        ),
      )

      .get('/collections/:id/follows', (c) =>
        c.json(followCounts(ctx, c.req.param('id'))),
      )

      .get('/collections/:id/follow-changes', query(FollowChangesQuery), (c) =>
        c.json(
          listFollowChanges(ctx, c.req.param('id'), c.req.valid('query').limit),
        ),
      )

      .get('/collections/:id/graph', query(OwnGraphQuery), (c) =>
        c.json(
          followGraph(readCtx(ctx, c), c.req.param('id'), {
            ...c.req.valid('query'),
            viewer: c.req.valid('query').viewer || undefined,
          }),
        ),
      )

      .get('/collections/:id/history/:capture', (c) =>
        c.json(getHistoryPoint(ctx, c.req.param('id'), c.req.param('capture'))),
      )

      .get('/entities/:id', (c) => c.json(getEntity(ctx, c.req.param('id'))))
  )
}
