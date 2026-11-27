// What the agent API says about a post or an account: the web's reads
// (`CollectionView`), reduced to plain fields an agent can use. Compact is
// for scanning many; full is for reading and citing a few.
import { sql } from 'drizzle-orm'
import { authorKey } from '#library/list.ts'
import {
  list,
  type AssetView,
  type CollectionView,
  type EntityView,
} from '#library/views.ts'
import { authorEntity, isProfile, profileURL } from '#telegram/presentation.ts'
import type { Executor } from '#db/client.ts'

export type View = 'compact' | 'full'
export const VIEWS: readonly View[] = ['compact', 'full']

/** Text cut in the compact view; full keeps all of it. */
const COMPACT_TEXT = 280
/** A quoted post's text, compact. */
const COMPACT_QUOTE = 140
const METRICS = ['likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'views']

export interface Annotations {
  note: string
  tags: { id: string; name: string }[]
}

/** Notes and tags (我的整理) of saved collections. */
export function annotationsOf(
  db: Executor,
  ids: readonly string[],
): Map<string, Annotations> {
  const out = new Map<string, Annotations>()
  if (!ids.length) return out
  for (const row of db.all<{ id: string; note: string }>(
    sql`SELECT collection_id AS id, note FROM library
      WHERE collection_id IN (SELECT value FROM json_each(${list(ids)}))`,
  ))
    out.set(row.id, { note: row.note, tags: [] })
  for (const row of db.all<{ collection: string; id: string; name: string }>(
    sql`SELECT ct.collection_id AS collection, t.id, t.name
      FROM collection_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.collection_id IN (SELECT value FROM json_each(${list(ids)}))
      ORDER BY t.name, t.id`,
  ))
    out.get(row.collection)?.tags.push({ id: row.id, name: row.name })
  return out
}

export interface ShapeOptions {
  view: View
  /** Scheme and host of the request, for links this server signs. */
  origin: string
  annotations: Map<string, Annotations>
}

type Data = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
const record = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : {}

function cut(value: string, max: number): [string, boolean] {
  const chars = [...value]
  return chars.length > max
    ? [`${chars.slice(0, max).join('')}…`, true]
    : [value, false]
}

/** Links this server signs are relative; an agent needs them whole. */
const absolute = (origin: string, url: string | undefined) =>
  url?.startsWith('/') ? `${origin}${url}` : url

const platformOf = (type: string) => type.split('.', 1)[0]!

function rootOf(c: CollectionView): EntityView | undefined {
  return c.graph?.entities.find((e) => e.key === c.graph!.root)
}

/** Whether a collection is an account (its root is a profile). */
export const isAccount = (c: CollectionView) =>
  isProfile(c) || (rootOf(c)?.type.endsWith('.profile') ?? false)

/** The newest data the archive has for an entity. */
const latest = (e: EntityView): Data => record(e.current?.data ?? e.data)

/** An account as other items name it: enough to find it again. */
export interface AccountRef {
  /** Its saved collection, when the account is saved. */
  id?: string
  /** `platform/type/platform id`: what `author` and `rel_of` take. */
  key: string
  handle?: string
  name?: string
}

function accountRef(e: EntityView): AccountRef {
  const data = latest(e)
  const handle = text(data.username)
  const name = text(data.name).trim()
  return {
    ...(e.saved_collection_id ? { id: e.saved_collection_id } : {}),
    key: authorKey({
      platform: platformOf(e.type),
      kind: e.type,
      external: e.external_id,
    }),
    ...(handle ? { handle } : {}),
    ...(name ? { name } : {}),
  }
}

export interface MediaItem {
  kind: string
  /** `ready`, `removed` (deleted to save space), `failed`, `pending`. */
  state: string
  url?: string
  thumbnail_url?: string
  alt_text?: string
  sensitive: boolean
  mime?: string
  width?: number
  height?: number
}

function mediaItem(origin: string, a: AssetView): MediaItem {
  return {
    kind: a.kind,
    state: a.state,
    ...(a.url ? { url: absolute(origin, a.url) } : {}),
    ...(a.thumbnail_url
      ? { thumbnail_url: absolute(origin, a.thumbnail_url) }
      : {}),
    ...(a.alt_text ? { alt_text: a.alt_text } : {}),
    sensitive: a.sensitive,
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
  }
}

function mediaCounts(assets: AssetView[]) {
  const images = assets.filter((a) => a.kind === 'image').length
  const videos = assets.filter((a) => a.kind === 'video').length
  return images || videos ? { media: { images, videos } } : {}
}

/** The platform's address of a post known only by reference. */
function postURL(e: EntityView): string | undefined {
  if (e.type === 'x.post') return `https://x.com/i/status/${e.external_id}`
  const shortcode = text(e.data.shortcode)
  if (e.type === 'instagram.post' && shortcode)
    return `https://www.instagram.com/p/${shortcode}/`
  return undefined
}

function relatedTo(c: CollectionView, source: string, type: string) {
  const graph = c.graph
  if (!graph) return []
  return graph.relations
    .filter((r) => r.source === source && r.type === type)
    .map((r) => graph.entities.find((e) => e.key === r.target))
    .filter((e): e is EntityView => !!e)
}

/** A post this one quotes or reposts, as far as the archive has it. */
function referenced(c: CollectionView, e: EntityView, o: ShapeOptions): Data {
  const author = e.saved_author ?? relatedTo(c, e.key, 'authored_by')[0]
  const body = e.saved_text ?? text(e.data.text)
  const [shown, truncated] =
    o.view === 'full' ? [body, false] : cut(body, COMPACT_QUOTE)
  const media = (e.assets ?? []).filter((a) => !a.purpose)
  return {
    ...(e.saved_collection_id ? { id: e.saved_collection_id } : {}),
    ...(postURL(e) ? { url: postURL(e) } : {}),
    platform_id: e.external_id,
    ...(author ? { author: accountRef(author) } : {}),
    ...(shown ? { text: shown } : {}),
    ...(truncated ? { text_truncated: true } : {}),
    ...(shown && e.saved_lang ? { lang: e.saved_lang } : {}),
    ...(o.view === 'full'
      ? media.length
        ? { media: media.map((a) => mediaItem(o.origin, a)) }
        : {}
      : mediaCounts(media)),
  }
}

function annotationFields(id: string, o: ShapeOptions) {
  const a = o.annotations.get(id)
  if (!a) return {}
  const [note, truncated] =
    o.view === 'full' ? [a.note, false] : cut(a.note, COMPACT_TEXT)
  return {
    ...(o.view === 'full'
      ? { tags: a.tags }
      : a.tags.length
        ? { tags: a.tags.map((t) => t.name) }
        : {}),
    ...(note ? { note } : {}),
    ...(truncated ? { note_truncated: true } : {}),
  }
}

function stateFields(c: CollectionView) {
  return c.source_state
    ? {
        source_state: c.source_state,
        ...(c.source_state_at ? { source_state_since: c.source_state_at } : {}),
      }
    : {}
}

export function shapePost(c: CollectionView, o: ShapeOptions) {
  const root = rootOf(c)
  const data = record(root?.data)
  const author = authorEntity(c)
  const [body, truncated] =
    o.view === 'full' ? [c.text, false] : cut(c.text, COMPACT_TEXT)
  const metrics = Object.fromEntries(
    METRICS.flatMap((key) =>
      count(data[key]) === undefined ? [] : [[key, count(data[key])]],
    ),
  )
  const quoted = root ? relatedTo(c, root.key, 'quoted')[0] : undefined
  const reposted = root ? relatedTo(c, root.key, 'reposted')[0] : undefined
  const repostedBy = root
    ? (c.graph?.relations ?? [])
        .filter((r) => r.target === root.key && r.type === 'reposted')
        .map((r) => c.graph!.entities.find((e) => e.key === r.source))
        .filter((e): e is EntityView => !!e?.type.endsWith('.profile'))
    : []
  const full = o.view === 'full'
  const mentions = full && root ? relatedTo(c, root.key, 'mentions') : []
  return {
    id: c.id,
    kind: 'post' as const,
    platform: root ? platformOf(root.type) : c.provider_id,
    url: c.url,
    platform_id: c.external_id,
    author: author && author !== root ? accountRef(author) : null,
    text: body,
    ...(truncated ? { text_truncated: true } : {}),
    ...(c.lang ? { lang: c.lang } : {}),
    ...(c.published_at ? { published_at: c.published_at } : {}),
    ...(full && text(data.edited_at)
      ? { edited_at: text(data.edited_at) }
      : {}),
    ...(c.saved_at ? { saved_at: c.saved_at } : {}),
    updated_at: c.observed_at,
    ...(full
      ? c.assets.length
        ? { media: c.assets.map((a) => mediaItem(o.origin, a)) }
        : {}
      : mediaCounts(c.assets)),
    ...(Object.keys(metrics).length ? { metrics } : {}),
    ...(quoted ? { quoted: referenced(c, quoted, o) } : {}),
    ...(reposted ? { reposted: referenced(c, reposted, o) } : {}),
    ...(full && repostedBy.length
      ? { reposted_by: repostedBy.map((e) => accountRef(e)) }
      : {}),
    ...(mentions.length
      ? { mentions: mentions.map((e) => accountRef(e)) }
      : {}),
    ...stateFields(c),
    ...annotationFields(c.id, o),
  }
}

function image(origin: string, e: EntityView | undefined, purpose: string) {
  const asset = e?.assets?.find((a) => a.purpose === purpose)
  return absolute(origin, asset?.url ?? asset?.remote_url)
}

export function shapeAccount(c: CollectionView, o: ShapeOptions) {
  const root = rootOf(c)
  const data = record(root?.data)
  const metadata = record(data.metadata)
  const full = o.view === 'full'
  const [bio, truncated] = full
    ? [text(metadata.description), false]
    : cut(text(metadata.description), COMPACT_TEXT)
  const handle = text(data.username)
  const name = text(data.name).trim() || c.author_name?.trim() || ''
  const website = record(metadata.website)
  const pinned = Array.isArray(metadata.pinned_posts)
    ? metadata.pinned_posts.filter((id): id is string => typeof id === 'string')
    : undefined
  const verified = record(metadata.verification).verified
  return {
    id: c.id,
    kind: 'account' as const,
    platform: root ? platformOf(root.type) : c.provider_id,
    url: profileURL(root) ?? c.url,
    ...(root
      ? {
          key: authorKey({
            platform: platformOf(root.type),
            kind: root.type,
            external: root.external_id,
          }),
        }
      : {}),
    platform_id: c.external_id,
    ...(handle ? { handle } : {}),
    ...(name ? { name } : {}),
    ...(bio ? { bio } : {}),
    ...(truncated ? { bio_truncated: true } : {}),
    ...(c.lang ? { lang: c.lang } : {}),
    ...(count(metadata.followers) === undefined
      ? {}
      : { followers: count(metadata.followers) }),
    ...(count(metadata.following) === undefined
      ? {}
      : { following: count(metadata.following) }),
    ...(count(metadata.statuses) === undefined
      ? {}
      : { posts: count(metadata.statuses) }),
    ...(typeof metadata.protected === 'boolean'
      ? { protected: metadata.protected }
      : {}),
    ...(typeof verified === 'boolean' ? { verified } : {}),
    ...(full
      ? {
          ...(count(metadata.likes) === undefined
            ? {}
            : { likes: count(metadata.likes) }),
          ...(count(metadata.media_count) === undefined
            ? {}
            : { media_count: count(metadata.media_count) }),
          ...(text(metadata.location)
            ? { location: text(metadata.location) }
            : {}),
          ...(text(website.url) || text(metadata.url)
            ? { website: text(website.url) || text(metadata.url) }
            : {}),
          ...(text(metadata.joined) ? { joined: text(metadata.joined) } : {}),
          ...(image(o.origin, root, 'avatar')
            ? { avatar_url: image(o.origin, root, 'avatar') }
            : {}),
          ...(image(o.origin, root, 'banner')
            ? { banner_url: image(o.origin, root, 'banner') }
            : {}),
          ...(pinned ? { pinned_posts: pinned } : {}),
        }
      : {}),
    ...(c.saved_at ? { saved_at: c.saved_at } : {}),
    updated_at: c.observed_at,
    ...stateFields(c),
    ...annotationFields(c.id, o),
  }
}

export type AgentPost = ReturnType<typeof shapePost>
export type AgentAccount = ReturnType<typeof shapeAccount>

/** A post or an account, by what the collection is. */
export function shape(c: CollectionView, o: ShapeOptions) {
  return isAccount(c) ? shapeAccount(c, o) : shapePost(c, o)
}
