import { AppError } from '#errors.ts'
import { listProfileChanges, type ProfileChanges } from './changes.ts'
import { filterCounts } from './counts.ts'
import { parseFilterQuery } from './filter-query.ts'
import { listCollections } from './list.ts'
import {
  getCollection,
  getHistoryPoint,
  listCounts,
  listHistory,
  type CountsSeries,
  type HistoryPoint,
} from './read.ts'
import { openShare, type OpenShare, type ShareTarget } from './shares.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type {
  CollectionView,
  EntityVersionView,
  EntityView,
  IncomingRelation,
  Page,
} from './views.ts'

/**
 * Public reads (分享). Every read opens the share and checks that what it
 * asks for is inside the share's scope as it is now; anything else is
 * `not_found`, the same answer as for what does not exist. What comes back
 * is the private view with the owner's own records taken out, and links
 * only to collections inside the scope.
 */

/** What a public address opens. */
export interface PublicShare {
  target: ShareTarget
  /** For a shared collection: the collection. */
  collection_id?: string
  /** For a shared folder: its name and how much of each kind it holds. */
  name?: string
  posts?: number
  profiles?: number
}

export type ListKind = 'post' | 'profile'

export interface PublicListQuery {
  /** A folder's posts or its accounts. */
  kind?: ListKind
  /** A profile's attached posts instead of the folder's own list. */
  related_to?: string
  /** For a profile's posts, as the private page orders them. */
  sort?: string
  order?: string
  cursor?: string
}

/** Every entity type the platforms know of this kind. */
function typesOf(ctx: AccountsContext, kind: ListKind): string[] {
  return ctx.platforms
    .all()
    .flatMap((platform) => platform.description.entityTypes)
    .map((type) => type.name)
    .filter((name) => name.endsWith(`.${kind}`))
}

/** The folder's own types narrowed to one kind; empty when none is left. */
function narrowed(
  ctx: AccountsContext,
  own: string | undefined,
  kind: ListKind,
): string {
  const wanted = typesOf(ctx, kind)
  const types = own ? own.split(',').filter((t) => wanted.includes(t)) : wanted
  return types.join(',')
}

function folderFilter(share: OpenShare) {
  if (share.target !== 'folder') throw new AppError('not_found')
  return parseFilterQuery(share.filter!).filter
}

export function getPublicShare(
  ctx: AccountsContext,
  slug: string,
): PublicShare {
  const share = openShare(ctx.db, slug)
  if (share.target === 'collection')
    return { target: 'collection', collection_id: share.target_id }
  folderFilter(share)
  // The same cached counts the folder list shows, by root type.
  const { types } = filterCounts(ctx.db, share.filter!)
  const count = (kind: ListKind) =>
    Object.entries(types)
      .filter(([type]) => type.endsWith(`.${kind}`))
      .reduce((sum, [, n]) => sum + n, 0)
  return {
    target: 'folder',
    name: share.name!,
    posts: count('post'),
    profiles: count('profile'),
  }
}

/** Keep a link to a saved collection only where the share reaches it. */
function linkWithin(entity: EntityView, linkable: Set<string>): void {
  delete entity.id
  delete entity.version_id
  if (entity.saved_collection_id && !linkable.has(entity.saved_collection_id))
    delete entity.saved_collection_id
  if (entity.current) delete (entity.current as Partial<EntityVersionView>).id
  if (entity.saved_author) linkWithin(entity.saved_author, linkable)
}

function savedLinks(view: CollectionView): string[] {
  const ids: string[] = []
  const add = (entity?: EntityView) => {
    if (!entity) return
    if (entity.saved_collection_id) ids.push(entity.saved_collection_id)
    add(entity.saved_author)
  }
  for (const entity of view.graph?.entities ?? []) add(entity)
  for (const relation of view.incoming_relations ?? []) {
    add(relation.entity)
    add(relation.author)
  }
  return ids
}

/**
 * Who reposted or quoted this, as far as the share reaches. An account
 * outside it keeps only its name and avatar, linking to the platform; a
 * post outside it is left out.
 */
function incomingWithin(
  relations: IncomingRelation[],
  linkable: Set<string>,
): IncomingRelation[] {
  const kept: IncomingRelation[] = []
  for (const relation of relations) {
    const saved = relation.entity.saved_collection_id
    if (saved && linkable.has(saved)) kept.push(relation)
    else if (relation.entity.type.endsWith('.profile')) {
      const { name, username } = relation.entity.data
      kept.push({
        type: relation.type,
        entity: {
          key: relation.entity.key,
          type: relation.entity.type,
          external_id: relation.entity.external_id,
          data: { name, username },
          assets: relation.entity.assets?.filter((a) => a.purpose === 'avatar'),
        },
      })
    }
  }
  for (const relation of kept) {
    linkWithin(relation.entity, linkable)
    if (relation.author) linkWithin(relation.author, linkable)
  }
  return kept
}

/** The private view without the owner's records or links out of scope. */
function publicViews(
  share: OpenShare,
  views: CollectionView[],
): CollectionView[] {
  const linkable = share.scope.contains([
    ...new Set(views.flatMap((view) => savedLinks(view))),
  ])
  for (const view of views) {
    delete view.saved_at
    delete view.storage_bytes
    for (const entity of view.graph?.entities ?? [])
      linkWithin(entity, linkable)
    if (view.incoming_relations) {
      const kept = incomingWithin(view.incoming_relations, linkable)
      if (kept.length) view.incoming_relations = kept
      else delete view.incoming_relations
    }
  }
  return views
}

/** The share, if it reaches this collection. */
function within(ctx: AccountsContext, slug: string, id: string): OpenShare {
  const share = openShare(ctx.db, slug)
  if (!share.scope.contains([id]).has(id)) throw new AppError('not_found')
  return share
}

/**
 * A shared folder's list (one kind at a time), or the attached posts of a
 * profile the share shows, as the private page lists them.
 */
export function listPublicCollections(
  ctx: AccountsContext,
  slug: string,
  query: PublicListQuery,
): Page<CollectionView> {
  const share = openShare(ctx.db, slug)
  let page: Page<CollectionView>
  if (query.related_to) {
    const posts = share.scope.profilePosts(query.related_to)
    if (!posts) throw new AppError('not_found')
    page = listCollections(
      ctx,
      {
        ...posts,
        sort: query.sort || undefined,
        order: query.order || undefined,
      },
      query.cursor || undefined,
    )
  } else {
    const filter = folderFilter(share)
    const entityType = narrowed(ctx, filter.entityType, query.kind ?? 'post')
    page = entityType
      ? listCollections(
          ctx,
          { ...filter, entityType },
          query.cursor || undefined,
        )
      : { items: [] }
  }
  return {
    items: publicViews(share, page.items),
    ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
  }
}

export function getPublicCollection(
  ctx: AccountsContext,
  slug: string,
  id: string,
): CollectionView {
  const share = within(ctx, slug, id)
  return publicViews(share, [getCollection(ctx, id)])[0]!
}

export function listPublicHistory(
  ctx: AccountsContext,
  slug: string,
  id: string,
  cursor?: string,
): Page<HistoryPoint> {
  within(ctx, slug, id)
  return listHistory(ctx, id, cursor)
}

export function getPublicHistoryPoint(
  ctx: AccountsContext,
  slug: string,
  id: string,
  captureId: string,
): CollectionView {
  const share = within(ctx, slug, id)
  return publicViews(share, [getHistoryPoint(ctx, id, captureId)])[0]!
}

export function listPublicCounts(
  ctx: AccountsContext,
  slug: string,
  id: string,
  limit?: number,
): CountsSeries {
  within(ctx, slug, id)
  return listCounts(ctx, id, limit)
}

export function listPublicProfileChanges(
  ctx: AccountsContext,
  slug: string,
  id: string,
  limit?: number,
): ProfileChanges {
  within(ctx, slug, id)
  return listProfileChanges(ctx, id, limit)
}
