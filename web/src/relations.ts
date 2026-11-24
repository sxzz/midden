import { previewURL, type Collection, type Entity } from './api'
type Graph = NonNullable<Collection['graph']>
export const isProfileEntity = (
  entity?: Entity,
): entity is Entity & { type: 'x.profile' | 'instagram.profile' } =>
  entity?.type === 'x.profile' || entity?.type === 'instagram.profile'
export const isPostEntity = (
  entity?: Entity,
): entity is Entity & { type: 'x.post' | 'instagram.post' } =>
  entity?.type === 'x.post' || entity?.type === 'instagram.post'
/** Who a related post is attributed to, as far as the saved data can tell. */
export interface RelationAuthor {
  name?: string
  handle?: string
  /** An avatar already saved here; the app never requests a remote one. */
  avatar?: string
  /** Only profiles saved in the library become internal links. */
  href?: string
  protected?: boolean
}
const asText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
/** The profile an entity points at with `authored_by` in the captured graph. */
export function authoredBy(graph: Graph | undefined, key: string) {
  const target = graph?.relations.find(
    (relation) => relation.source === key && relation.type === 'authored_by',
  )?.target
  // A post kept by reference names its author only through its saved copy.
  if (!target)
    return graph?.entities.find((entity) => entity.key === key)?.saved_author
  return graph?.entities.find(
    (entity) => entity.key === target && isProfileEntity(entity),
  )
}
/**
 * An author reads as its newest version; `captured` asks for the one this
 * capture recorded instead.
 */
export function profileVersion(
  entity: Entity | undefined,
  captured = false,
): Entity | undefined {
  if (!entity?.current || captured) return entity
  return {
    ...entity,
    data: entity.current.data,
    // Keep the captured avatar when the newer version saved none.
    assets: entity.current.assets?.length
      ? entity.current.assets
      : entity.assets,
  }
}
/** The avatar a header may show: saved, ready and not sensitive. */
const shownAvatar = (entity?: Entity) =>
  entity?.assets?.find(
    (asset) =>
      asset.purpose === 'avatar' && asset.state === 'ready' && !asset.sensitive,
  )
/** What a reader sees of an account, as one comparable value. */
function seen(entity?: Entity) {
  const avatar = shownAvatar(entity)
  return JSON.stringify([
    asText(entity?.data.name),
    asText(entity?.data.username),
    isProtected(entity),
    avatar && (avatar.sha256 || avatar.url),
  ])
}
/**
 * Whether switching an author between its captured and newest version
 * changes what a reader sees; a newer version often differs only in counts.
 */
export function profileDiffers(entity?: Entity): boolean {
  return (
    !!entity?.current &&
    seen(profileVersion(entity, true)) !== seen(profileVersion(entity))
  )
}
/**
 * Whether a post's 抓取时资料/最新资料 switch would change anything: it
 * switches the post's author and the authors of the posts it relates to.
 */
export function collectionProfilesDiffer(collection: Collection): boolean {
  const graph = collection.graph
  if (
    !isPostEntity(graph?.entities.find((entity) => entity.key === graph.root))
  )
    return false
  return [
    // A post kept by reference names its author through its saved copy.
    ...(graph?.entities ?? []).flatMap((entity) => [
      entity,
      entity.saved_author,
    ]),
    ...(collection.incoming_relations ?? []).flatMap((relation) => [
      relation.entity,
      relation.author,
    ]),
  ].some(profileDiffers)
}
/** Whether an account is protected; undefined when the profile never said. */
export function isProtected(entity?: Entity): boolean | undefined {
  if (!isProfileEntity(entity)) return
  const metadata = entity.data.metadata as Record<string, unknown> | undefined
  return typeof metadata?.protected === 'boolean'
    ? metadata.protected
    : undefined
}
/** Attribution is only shown when the snapshot actually recorded it. */
export function authorIdentity(
  author?: Entity,
  captured = false,
): RelationAuthor | undefined {
  const entity = profileVersion(author, captured)
  if (!isProfileEntity(entity)) return
  const name = asText(entity.data.name)
  const handle = asText(entity.data.username)
  if (!name && !handle) return
  // Sensitive media stays behind its own control, so a header never reveals it.
  const avatar = shownAvatar(entity)
  return {
    name,
    handle,
    avatar: avatar && previewURL(avatar),
    href: entity.saved_collection_id
      ? `#/collection/${encodeURIComponent(entity.saved_collection_id)}`
      : undefined,
    protected: isProtected(entity),
  }
}
/** One line of attribution for places that cannot render a link. */
export function authorLabel(author?: RelationAuthor) {
  return [author?.name, author?.handle && `@${author.handle}`]
    .filter(Boolean)
    .join(' ')
}
