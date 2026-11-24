import { Hono } from 'hono'
import * as v from 'valibot'
import { CHANGES_WINDOW, listProfileChanges } from '#library/changes.ts'
import { getEntity } from '#library/entities.ts'
import { listAuthors, listCollections } from '#library/list.ts'
import {
  COUNTS_LIMIT,
  getCollection,
  getHistoryPoint,
  listCounts,
  listHistory,
} from '#library/read.ts'
import { getSource, listSources } from '#library/sources.ts'
import { Cursor, query, type Env } from './validate.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const text = v.optional(v.string())

/** Collection list filters; list.ts checks their values. */
const Filters = v.object({
  q: text,
  entity_type: text,
  media_type: text,
  visibility: text,
  saved_from: text,
  saved_before: text,
  sort: text,
  order: text,
  author: v.optional(v.union([v.string(), v.array(v.string())])),
  sensitive: text,
  tag: text,
  related_to: text,
  post_type: text,
  cursor: text,
})

const AuthorFilters = v.object({
  q: text,
  cursor: text,
  author: v.optional(v.union([v.string(), v.array(v.string())])),
})

/** How many of the newest readings to return, at most COUNTS_LIMIT. */
const CountsQuery = v.object({
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
const ChangesQuery = v.object({
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

/** Reading the library: collections, their history, entities, raw sources. */
export function libraryRoutes(ctx: AccountsContext) {
  return (
    new Hono<Env>()
      .get('/collections', query(Filters), (c) => {
        const input = c.req.valid('query')
        const author = input.author ?? []
        return c.json(
          listCollections(
            ctx,
            {
              q: input.q || undefined,
              entityType: input.entity_type || undefined,
              mediaType: input.media_type || undefined,
              visibility: input.visibility || undefined,
              savedFrom: input.saved_from || undefined,
              savedBefore: input.saved_before || undefined,
              sort: input.sort || undefined,
              order: input.order || undefined,
              authors: typeof author === 'string' ? [author] : author,
              sensitive: input.sensitive || undefined,
              tag: input.tag || undefined,
              relatedTo: input.related_to || undefined,
              postType: input.post_type || undefined,
            },
            input.cursor || undefined,
          ),
        )
      })

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

      .get('/collections/:id/history/:capture', (c) =>
        c.json(getHistoryPoint(ctx, c.req.param('id'), c.req.param('capture'))),
      )

      .get('/entities/:id', (c) => c.json(getEntity(ctx, c.req.param('id'))))

      .get('/collections/:id/sources', (c) =>
        c.json(listSources(ctx, c.req.param('id'))),
      )

      // Raw upstream bytes: shown as they were, but never run as this site.
      .get('/sources/:id', (c) => {
        const source = getSource(ctx, c.req.param('id'))
        return new Response(new Uint8Array(source.body), {
          headers: {
            'Content-Type': source.content_type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
            'Cache-Control': 'no-store',
          },
        })
      })
  )
}
