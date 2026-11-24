import { Hono } from 'hono'
import * as v from 'valibot'
import { CHANGES_WINDOW, listProfileChanges } from '#library/changes.ts'
import { compareRelations, compareSides } from '#library/compare.ts'
import { filterCounts } from '#library/counts.ts'
import { getEntity } from '#library/entities.ts'
import { collectionFilter, FilterQuery } from '#library/filter-query.ts'
import {
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
})

/** Reading the library: collections, their history, and entities. */
export function libraryRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      .get('/collections', query(Filters), (c) => {
        const input = c.req.valid('query')
        return c.json(
          listCollections(
            ctx,
            collectionFilter(input),
            input.cursor || undefined,
          ),
        )
      })

      // Cached like the folders' counts; the web asks before splitting a
      // folder into post and account tabs.
      .get('/collections/count', query(FilterQuery), (c) =>
        c.json(filterCounts(ctx.db, new URL(c.req.url).search)),
      )

      .get('/collections/authors', query(AuthorFilters), (c) => {
        const input = c.req.valid('query')
        const author = input.author ?? []
        return c.json(
          listAuthors(ctx, {
            q: input.q || undefined,
            cursor: input.cursor || undefined,
            authors: typeof author === 'string' ? [author] : author,
          }),
        )
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
          compareRelations(ctx, {
            relOf: input.rel_of,
            rel: input.rel,
            min: input.rel_min,
            only: input.only,
            limit: input.limit,
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

      .get('/collections/:id/graph', query(GraphQuery), (c) =>
        c.json(followGraph(ctx, c.req.param('id'), c.req.valid('query'))),
      )

      .get('/collections/:id/history/:capture', (c) =>
        c.json(getHistoryPoint(ctx, c.req.param('id'), c.req.param('capture'))),
      )

      .get('/entities/:id', (c) => c.json(getEntity(ctx, c.req.param('id'))))
  )
}
