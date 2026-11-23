import { getEntity } from '#library/entities.ts'
import { listAuthors, listCollections } from '#library/list.ts'
import { getCollection, getRevision, listRevisions } from '#library/read.ts'
import { getSource, listSources } from '#library/sources.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Env } from './app.ts'
import type { Hono } from 'hono'

/** Reading the library: collections, their history, entities, raw sources. */
export function libraryRoutes(app: Hono<Env>, ctx: AccountsContext): void {
  app.get('/collections', (c) => {
    const query = (name: string) => c.req.query(name) || undefined
    return c.json(
      listCollections(
        ctx,
        {
          q: query('q'),
          entityType: query('entity_type'),
          mediaType: query('media_type'),
          visibility: query('visibility'),
          savedFrom: query('saved_from'),
          savedBefore: query('saved_before'),
          sort: query('sort'),
          order: query('order'),
          authors: c.req.queries('author') ?? [],
          sensitive: query('sensitive'),
          tag: query('tag'),
          relatedTo: query('related_to'),
          postType: query('post_type'),
        },
        query('cursor'),
      ),
    )
  })

  app.get('/collections/authors', (c) => c.json(listAuthors(ctx)))

  app.get('/collections/:id', (c) =>
    c.json(getCollection(ctx, c.req.param('id'))),
  )

  app.get('/collections/:id/revisions', (c) =>
    c.json(
      listRevisions(ctx, c.req.param('id'), c.req.query('cursor') || undefined),
    ),
  )

  app.get('/collections/:id/revisions/:revision', (c) =>
    c.json(getRevision(ctx, c.req.param('id'), c.req.param('revision'))),
  )

  app.get('/entities/:id', (c) => c.json(getEntity(ctx, c.req.param('id'))))

  app.get('/collections/:id/sources', (c) =>
    c.json(listSources(ctx, c.req.param('id'))),
  )

  // Raw upstream bytes: shown as they were, but never run as this site.
  app.get('/sources/:id', (c) => {
    const source = getSource(ctx, c.req.param('id'))
    return new Response(source.body, {
      headers: {
        'Content-Type': source.content_type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'no-store',
      },
    })
  })
}
