import { assetURL, type Collection, type Entity } from './api'
type Graph = NonNullable<Collection['graph']>
/** Who a related post is attributed to, as far as the saved data can tell. */
export interface RelationAuthor {
  name?: string
  handle?: string
  /** An avatar already saved here; the app never requests a remote one. */
  avatar?: string
  /** Only profiles saved in this tenant become internal links. */
  href?: string
}
const asText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
/** The profile an entity points at with `authored_by` in the captured graph. */
export function authoredBy(graph: Graph | undefined, key: string) {
  const target = graph?.relations.find(
    (relation) => relation.source === key && relation.type === 'authored_by',
  )?.target
  if (!target) return
  return graph?.entities.find(
    (entity) => entity.key === target && entity.type === 'x.profile',
  )
}
/** Attribution is only shown when the snapshot actually recorded it. */
export function authorIdentity(entity?: Entity): RelationAuthor | undefined {
  if (entity?.type !== 'x.profile') return
  const name = asText(entity.data.name)
  const handle = asText(entity.data.username)
  if (!name && !handle) return
  // Sensitive media stays behind its own control, so a header never reveals it.
  const avatar = entity.assets?.find(
    (asset) =>
      asset.purpose === 'avatar' && asset.state === 'ready' && !asset.sensitive,
  )
  return {
    name,
    handle,
    avatar: avatar && assetURL(avatar),
    href: entity.saved_collection_id
      ? `#/collection/${encodeURIComponent(entity.saved_collection_id)}`
      : undefined,
  }
}
/** One line of attribution for places that cannot render a link. */
export function authorLabel(author?: RelationAuthor) {
  return [author?.name, author?.handle && `@${author.handle}`]
    .filter(Boolean)
    .join(' ')
}
