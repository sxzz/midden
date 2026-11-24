import { AppError } from '#errors.ts'
import { listProfileChanges, type ProfileChanges } from './changes.ts'
import { filterCounts, narrowedCounts } from './counts.ts'
import {
  collectionFilter,
  parseFilterQuery,
  type FilterParams,
} from './filter-query.ts'
import {
  followGraph,
  type FollowGraph,
  type GraphQuery,
} from './follow-graph.ts'
import {
  followCounts,
  listFollowChanges,
  type FollowChanges,
  type FollowCounts,
} from './follows.ts'
import {
  listAuthors,
  listCollections,
  type Author,
  type AuthorFilter,
  type FilterCounts,
  type Narrowing,
} from './list.ts'
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

/**
 * A public list: a shared folder's, or the attached posts of a profile the
 * share shows. A visitor filters and orders it as the private list, except
 * by tag, which would name the owner's tags, by save date or size, which
 * public views leave out, and by follows (「关系」), whose accounts reach
 * beyond the share.
 */
export interface PublicListQuery extends Omit<
  FilterParams,
  | 'tag'
  | 'tag_mode'
  | 'not_tag'
  | 'rel_of'
  | 'rel'
  | 'rel_min'
  | 'related_to'
  | 'saved_from'
  | 'saved_before'
  | 'saved_within'
  | 'time_zone'
  | 'sort'
> {
  sort?: '' | 'published' | 'updated' | 'followers' | 'following'
  /** A profile's attached posts instead of the folder's own list. */
  related_to?: string
  cursor?: string
}

/**
 * A public list without a chosen order shows the newest posts first. An
 * account has no post time and counts as published when last updated.
 */
const PUBLIC_SORT = 'published'

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
  const count = (kind: 'post' | 'profile') =>
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
 * What a public list starts from: a profile's attached posts when the share
 * shows that profile, else the shared folder's filter.
 */
function listedBy(share: OpenShare, relatedTo: string | undefined) {
  if (!relatedTo) return folderFilter(share)
  const posts = share.scope.profilePosts(relatedTo)
  if (!posts) throw new AppError('not_found')
  return posts
}

/**
 * What a public list selects, and from where its page goes on: the shared
 * folder's filter, or a profile's attached posts, narrowed by the visitor's
 * filters, which are added to it, never in place of it. The visitor's order
 * replaces the folder's; without one, the newest posts come first.
 */
function publicSelection(share: OpenShare, query: PublicListQuery) {
  const { related_to: relatedTo, cursor, ...params } = query
  const base = listedBy(share, relatedTo || undefined)
  const visitor = collectionFilter(params)
  const narrow: Narrowing = {
    q: visitor.q,
    entityType: visitor.entityType,
    mediaType: visitor.mediaType,
    visibility: visitor.visibility,
    authors: visitor.authors,
    sensitive: visitor.sensitive,
    postType: visitor.postType,
  }
  return {
    base: {
      ...base,
      sort: visitor.sort ?? PUBLIC_SORT,
      order: visitor.order ?? 'desc',
    },
    narrow,
    cursor: cursor || undefined,
  }
}

/** A shared folder's list, or the attached posts of a profile the share shows. */
export function listPublicCollections(
  ctx: AccountsContext,
  slug: string,
  query: PublicListQuery,
): Page<CollectionView> {
  const share = openShare(ctx.db, slug)
  const { base, narrow, cursor } = publicSelection(share, query)
  const page = listCollections(ctx, base, cursor, narrow)
  return {
    items: publicViews(share, page.items),
    ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
  }
}

/** How much a public list holds over all its pages, by root type. */
export function countPublicCollections(
  ctx: AccountsContext,
  slug: string,
  query: PublicListQuery,
): FilterCounts {
  const share = openShare(ctx.db, slug)
  const { base, narrow } = publicSelection(share, query)
  return narrowedCounts(ctx.db, base, narrow)
}

/**
 * The authors of what a public list starts from, counted within it: the
 * author picker of a shared folder or profile, which names no one else.
 */
export function listPublicAuthors(
  ctx: AccountsContext,
  slug: string,
  input: AuthorFilter & { related_to?: string },
): Page<Author> {
  const share = openShare(ctx.db, slug)
  const { related_to: relatedTo, ...filter } = input
  return listAuthors(ctx, filter, listedBy(share, relatedTo || undefined))
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

export function getPublicFollowCounts(
  ctx: AccountsContext,
  slug: string,
  id: string,
): FollowCounts {
  within(ctx, slug, id)
  return followCounts(ctx, id)
}

/**
 * A shared profile's follow changes. Every account keeps its name and
 * avatar; only those the share reaches link to their saved profile.
 */
export function listPublicFollowChanges(
  ctx: AccountsContext,
  slug: string,
  id: string,
  limit?: number,
): FollowChanges {
  const share = within(ctx, slug, id)
  const changes = listFollowChanges(ctx, id, limit)
  const linkable = share.scope.contains([
    ...new Set(
      changes.items.flatMap((item) =>
        item.account.collection_id ? [item.account.collection_id] : [],
      ),
    ),
  ])
  for (const { account } of changes.items)
    if (account.collection_id && !linkable.has(account.collection_id))
      delete account.collection_id
  return changes
}

/**
 * A shared profile's follow graph, under the rule of its follow changes:
 * every account keeps its name and avatar, only those the share reaches
 * link to their saved profile.
 */
export function getPublicFollowGraph(
  ctx: AccountsContext,
  slug: string,
  id: string,
  query?: GraphQuery,
): FollowGraph {
  const share = within(ctx, slug, id)
  const graph = followGraph(ctx, id, query)
  const linkable = share.scope.contains([
    ...new Set(
      graph.nodes.flatMap((node) =>
        node.collection_id ? [node.collection_id] : [],
      ),
    ),
  ])
  for (const node of graph.nodes)
    if (node.collection_id && !linkable.has(node.collection_id))
      delete node.collection_id
  return graph
}
