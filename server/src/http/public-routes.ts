import { Hono } from 'hono'
import * as v from 'valibot'
import { FilterQuery } from '#library/filter-query.ts'
import {
  countPublicCollections,
  getPublicCollection,
  getPublicFollowCounts,
  getPublicFollowGraph,
  getPublicHistoryPoint,
  getPublicShare,
  listPublicAuthors,
  listPublicCollections,
  listPublicCounts,
  listPublicFollowChanges,
  listPublicHistory,
  listPublicProfileChanges,
} from '#library/public.ts'
import {
  ChangesQuery,
  CountsQuery,
  FollowChangesQuery,
  GraphQuery,
} from './library-routes.ts'
import { Cursor, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const text = v.optional(v.string())

/**
 * The private list's filters but those that would tell the owner's own
 * data: tags name them, the save date and the `saved` and `storage` orders
 * tell when things were saved and how large they are, which public views
 * leave out, and follows (`rel_of`, `rel`, `rel_min`) reach accounts
 * beyond the share. Accounts' follower and following counts are public,
 * and so are their orders.
 * Strict, so any of these (or anything else unknown) is refused, not
 * ignored.
 */
const ListQuery = v.strictObject({
  ...v.omit(FilterQuery, [
    'tag',
    'tag_mode',
    'not_tag',
    'rel_of',
    'rel',
    'rel_min',
    'saved_from',
    'saved_before',
    'saved_within',
    'time_zone',
    'sort',
  ]).entries,
  sort: v.optional(
    v.picklist(['', 'published', 'updated', 'followers', 'following']),
  ),
  cursor: text,
})

/** The authors of a public list, which is a folder's or a profile's. */
const AuthorQuery = v.strictObject({
  q: text,
  cursor: text,
  author: v.optional(v.union([v.string(), v.array(v.string())])),
  related_to: text,
})

/**
 * Reads behind a public link, without login: `/v1/public/:slug/...`. Each
 * one checks the share's scope (`library/public.ts`); search engines are
 * asked to stay out.
 */
export function publicRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      .use(async (c, next) => {
        await next()
        c.header('X-Robots-Tag', 'noindex, nofollow')
        c.header('Referrer-Policy', 'no-referrer')
      })
      .get('/:slug', (c) => c.json(getPublicShare(ctx, c.req.param('slug'))))

      .get('/:slug/collections', query(ListQuery), (c) =>
        c.json(
          listPublicCollections(ctx, c.req.param('slug'), c.req.valid('query')),
        ),
      )

      // Registered before `:id`, which would take `count` for an id. Scoped
      // and narrowed exactly as the list is.
      .get('/:slug/collections/count', query(ListQuery), (c) =>
        c.json(
          countPublicCollections(
            ctx,
            c.req.param('slug'),
            c.req.valid('query'),
          ),
        ),
      )

      .get('/:slug/collections/authors', query(AuthorQuery), (c) => {
        // Registered before `:id`, which would take `authors` for an id.
        const input = c.req.valid('query')
        const author = input.author ?? []
        return c.json(
          listPublicAuthors(ctx, c.req.param('slug'), {
            q: input.q || undefined,
            cursor: input.cursor || undefined,
            authors: typeof author === 'string' ? [author] : author,
            related_to: input.related_to || undefined,
          }),
        )
      })

      .get('/:slug/collections/:id', (c) =>
        c.json(
          getPublicCollection(ctx, c.req.param('slug'), c.req.param('id')),
        ),
      )

      .get('/:slug/collections/:id/history', query(Cursor), (c) =>
        c.json(
          listPublicHistory(
            ctx,
            c.req.param('slug'),
            c.req.param('id'),
            c.req.valid('query').cursor || undefined,
          ),
        ),
      )

      .get('/:slug/collections/:id/history/:capture', (c) =>
        c.json(
          getPublicHistoryPoint(
            ctx,
            c.req.param('slug'),
            c.req.param('id'),
            c.req.param('capture'),
          ),
        ),
      )

      .get('/:slug/collections/:id/counts', query(CountsQuery), (c) =>
        c.json(
          listPublicCounts(
            ctx,
            c.req.param('slug'),
            c.req.param('id'),
            c.req.valid('query').limit,
          ),
        ),
      )

      .get('/:slug/collections/:id/follows', (c) =>
        c.json(
          getPublicFollowCounts(ctx, c.req.param('slug'), c.req.param('id')),
        ),
      )

      .get(
        '/:slug/collections/:id/follow-changes',
        query(FollowChangesQuery),
        (c) =>
          c.json(
            listPublicFollowChanges(
              ctx,
              c.req.param('slug'),
              c.req.param('id'),
              c.req.valid('query').limit,
            ),
          ),
      )

      .get(
        '/:slug/collections/:id/graph',
        query(v.strictObject(GraphQuery.entries)),
        (c) =>
          c.json(
            getPublicFollowGraph(
              ctx,
              c.req.param('slug'),
              c.req.param('id'),
              c.req.valid('query'),
            ),
          ),
      )

      .get('/:slug/collections/:id/profile-changes', query(ChangesQuery), (c) =>
        c.json(
          listPublicProfileChanges(
            ctx,
            c.req.param('slug'),
            c.req.param('id'),
            c.req.valid('query').limit,
          ),
        ),
      )
  )
}
