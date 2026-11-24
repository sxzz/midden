import { sql } from 'drizzle-orm'
import { overlayMetrics } from '#capture/metrics.ts'
import { metricKey, type Metrics, type Payload } from '#capture/payload.ts'
import { AppError } from '#errors.ts'
import {
  applyMetrics,
  assetsByCapture,
  assetsById,
  avatarOf,
  captureMetrics,
  head,
  hydrate,
  list,
  parseJson,
  type AssetView,
  type CollectionView,
  type EntityVersionView,
  type EntityView,
  type GraphView,
  type IncomingRelation,
  type Reader,
} from './views.ts'

export const AUTHORED_BY = 'authored_by'

/**
 * Joins `author_ref`, `author_version` and `author` to the first entity
 * (by key) that `source` in `revision` is authored by.
 */
const authorJoins = (revision: string, source: string) => `
  LEFT JOIN revision_entities author_ref ON author_ref.revision_id = ${revision}
    AND author_ref.entity_key = (
      SELECT min(edge.target_key) FROM entity_relations edge
      WHERE edge.revision_id = ${revision} AND edge.source_key = ${source}
        AND edge.kind = '${AUTHORED_BY}')
  LEFT JOIN entity_versions author_version ON author_version.id = author_ref.entity_version_id
  LEFT JOIN entities author ON author.id = author_version.entity_id`

const AUTHOR_COLUMNS = `author.id AS author_id, author_version.id AS author_version,
  author.kind AS author_type, author.external_id AS author_external,
  author_version.data AS author_data`

/** Anything with a graph whose entities can be linked. */
interface WithGraph {
  graph?: GraphView
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function graphEntities(views: readonly WithGraph[]): EntityView[] {
  return views.flatMap((view) => view.graph?.entities ?? [])
}

/** What the graph's root quotes or reposts. */
function referencedPosts(graph: GraphView): Set<string> {
  return new Set(
    graph.relations
      .filter(
        (r) =>
          r.source === graph.root &&
          (r.type === 'quoted' || r.type === 'reposted'),
      )
      .map((r) => r.target),
  )
}

/** The entities something in the graph is authored by, except its root. */
function graphAuthors(graph: GraphView): Set<string> {
  return new Set(
    graph.relations
      .filter((r) => r.type === AUTHORED_BY && r.target !== graph.root)
      .map((r) => r.target),
  )
}

function hasAvatar(entity: EntityView): boolean {
  return !!entity.assets?.some(
    (a) => a.purpose === 'avatar' && a.state === 'ready',
  )
}

/**
 * Link each entity to the saved collection about it: one whose head
 * revision is rooted at the entity, or else one an alias of the same
 * platform and external id points at, rooted at an entity of the same type.
 * Then add what those links make readable.
 */
export function linkSavedEntities(
  r: Reader,
  ...views: readonly WithGraph[]
): void {
  const ids = [
    ...new Set(
      graphEntities(views)
        .map((e) => e.id)
        .filter((id): id is string => !!id),
    ),
  ]
  if (!ids.length) return
  const candidates = r.db.all<{
    entity: string
    collection: string
    saved: number
    priority: number
  }>(sql`
    SELECT ev.entity_id AS entity, c.id AS collection, l.created_at AS saved,
      0 AS priority
    FROM entity_versions ev
    JOIN revision_entities re ON re.entity_version_id = ev.id AND re.is_root = 1
    JOIN revisions rv ON rv.id = re.revision_id
    JOIN collections c ON c.id = rv.collection_id
    JOIN library l ON l.collection_id = c.id
    WHERE ev.entity_id IN (SELECT value FROM json_each(${list(ids)}))
      AND rv.id = ${sql.raw(head('c.id'))}
    UNION ALL
    SELECT source.id, c.id, l.created_at, 1
    FROM entities source
    JOIN collection_identity_aliases alias
      ON alias.external_id = source.external_id AND alias.platform = source.platform
    JOIN collections c ON c.id = alias.collection_id AND c.platform = alias.platform
      AND c.kind = alias.kind AND c.object_scope = alias.object_scope
    JOIN library l ON l.collection_id = c.id
    JOIN revision_entities re ON re.revision_id = ${sql.raw(head('c.id'))} AND re.is_root = 1
    JOIN entity_versions ev ON ev.id = re.entity_version_id
    JOIN entities target ON target.id = ev.entity_id
      AND target.kind = source.kind AND target.platform = source.platform
    WHERE source.id IN (SELECT value FROM json_each(${list(ids)}))`)
  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.saved - a.saved ||
      byteOrder(a.collection, b.collection),
  )
  const links = new Map<string, string>()
  for (const c of candidates)
    if (!links.has(c.entity)) links.set(c.entity, c.collection)
  for (const entity of graphEntities(views)) {
    const link = entity.id && links.get(entity.id)
    if (link) entity.saved_collection_id = link
  }
  attachSavedAvatars(r, views)
  attachSavedSummaries(r, views)
  attachCurrentProfiles(r, views)
}

/**
 * A referenced account (a quoted post's author, say) is captured without
 * its avatar. When the account is saved, show the avatar of its saved
 * collection's root, never another account mentioned in that capture.
 */
function attachSavedAvatars(r: Reader, views: readonly WithGraph[]): void {
  const ids = [
    ...new Set(
      graphEntities(views)
        .filter((e) => e.saved_collection_id && !hasAvatar(e))
        .map((e) => e.saved_collection_id!),
    ),
  ]
  if (!ids.length) return
  const rows = r.db.all<{ collection: string; asset: string | null }>(sql`
    SELECT c.value AS collection, ${sql.raw(avatarOf('r', 're.entity_key'))} AS asset
    FROM json_each(${list(ids)}) c
    JOIN revisions r ON r.id = ${sql.raw(head('c.value'))}
    JOIN revision_entities re ON re.revision_id = r.id AND re.is_root = 1`)
  const assets = assetsById(
    r,
    rows.map((row) => row.asset).filter((id): id is string => !!id),
  )
  const avatars = new Map<string, AssetView>()
  for (const row of rows) {
    const asset = row.asset && assets.get(row.asset)
    if (asset) avatars.set(row.collection, asset)
  }
  for (const entity of graphEntities(views)) {
    const avatar = avatars.get(entity.saved_collection_id ?? '')
    if (avatar && !hasAvatar(entity)) (entity.assets ??= []).push(avatar)
  }
}

/**
 * A quoted or reposted post is kept by reference only; where it is saved,
 * show what its own collection says now.
 */
function attachSavedSummaries(r: Reader, views: readonly WithGraph[]): void {
  const referenced = views.flatMap((view) => {
    if (!view.graph) return []
    const keys = referencedPosts(view.graph)
    return view.graph.entities.filter(
      (e) => keys.has(e.key) && e.saved_collection_id,
    )
  })
  const saved = savedPosts(r, [
    ...new Set(referenced.map((e) => e.saved_collection_id!)),
  ])
  for (const entity of referenced) {
    const post = saved.get(entity.saved_collection_id!)
    if (!post) continue
    if (post.summary) entity.saved_summary = post.summary
    if (post.text) entity.saved_text = post.text
    if (post.author) entity.saved_author = post.author
    if (post.assets.length) (entity.assets ??= []).push(...post.assets)
  }
}

export interface SavedPost {
  summary: string
  text: string
  author?: EntityView
  assets: AssetView[]
}

/**
 * Saved collections' heads: what a post shown only by reference says, who
 * wrote it (linked like any graph entity) and its content media.
 */
export function savedPosts(
  r: Reader,
  ids: readonly string[],
): Map<string, SavedPost> {
  const out = new Map<string, SavedPost>()
  if (!ids.length) return out
  const rows = r.db.all<{
    collection: string
    summary: string | null
    text: string | null
    capture_id: string
    author_id: string | null
    author_version: string | null
    author_type: string | null
    author_external: string | null
    author_data: string | null
  }>(sql`
    SELECT c.value AS collection, r.payload ->> 'summary' AS summary,
      r.payload ->> 'text' AS text, r.capture_id, ${sql.raw(AUTHOR_COLUMNS)}
    FROM json_each(${list(ids)}) c
    JOIN revisions r ON r.id = ${sql.raw(head('c.value'))}
    LEFT JOIN revision_entities root ON root.revision_id = r.id AND root.is_root = 1
    ${sql.raw(authorJoins('r.id', 'root.entity_key'))}`)
  const authors: GraphView = { root: '', entities: [], relations: [] }
  const media = assetsByCapture(
    r,
    rows.map((row) => row.capture_id),
  )
  for (const row of rows) {
    const post: SavedPost = {
      summary: row.summary ?? '',
      text: row.text ?? '',
      assets: (media.get(row.capture_id) ?? []).filter((a) => !a.purpose),
    }
    if (row.author_id) {
      post.author = {
        id: row.author_id,
        version_id: row.author_version!,
        key: `saved_author_${authors.entities.length}`,
        type: row.author_type!,
        external_id: row.author_external!,
        data: parseJson(row.author_data),
      }
      authors.entities.push(post.author)
    }
    out.set(row.collection, post)
  }
  // Authors are linked and read like any graph entity.
  linkSavedEntities(r, { graph: authors })
  return out
}

/**
 * An entry keeps its author as captured, but reads with the author's
 * newest version: names, protection and counts change. Only versions
 * captured as a root, or as a root's own author, are complete; a quoted
 * entry's author is often just a name. The entity a collection is about is
 * never replaced, so its history still reads.
 */
function attachCurrentProfiles(r: Reader, views: readonly WithGraph[]): void {
  const authors = views.flatMap((view) => {
    if (!view.graph) return []
    const keys = graphAuthors(view.graph)
    return view.graph.entities.filter((e) => keys.has(e.key) && e.id)
  })
  const ids = [...new Set(authors.map((e) => e.id!))]
  if (!ids.length) return
  const rows = r.db.all<{
    entity: string
    version: string
    data: string
    metrics: string | null
    avatar: string | null
  }>(sql`
    SELECT wanted.value AS entity, ev.id AS version, ev.data, c.metrics,
      ${sql.raw(avatarOf('r', 're.entity_key'))} AS avatar
    FROM json_each(${list(ids)}) wanted
    -- The account's newest capture as a root or a root's author.
    JOIN catalog k ON k.rowid = (
      SELECT s.rowid FROM catalog s WHERE s.subject_entity_id = wanted.value
      ORDER BY s.revision_at DESC, s.revision_id DESC LIMIT 1)
    JOIN revisions r ON r.id = k.revision_id
    JOIN captures c ON c.id = r.capture_id
    JOIN revision_entities re ON re.revision_id = r.id
    JOIN entity_versions ev ON ev.id = re.entity_version_id
      AND ev.entity_id = wanted.value`)
  const avatars = assetsById(
    r,
    rows.map((row) => row.avatar).filter((id): id is string => !!id),
  )
  const latest = new Map(rows.map((row) => [row.entity, row]))
  for (const entity of authors) {
    const row = latest.get(entity.id!)
    if (!row || row.version === entity.version_id) continue
    // The current version reads with the counts its capture saw.
    const metrics = row.metrics ? parseJson<Metrics>(row.metrics) : undefined
    const current: EntityVersionView = {
      id: row.version,
      data: overlayMetrics(
        parseJson<Record<string, unknown>>(row.data),
        metrics?.[metricKey(entity)],
      ),
    }
    const avatar = row.avatar && avatars.get(row.avatar)
    if (avatar) current.assets = [avatar]
    entity.current = current
  }
}

/**
 * Saved revisions anywhere that repost or quote the collection's root,
 * one per source identity, read at the source's latest saved version. The
 * captured graph is never changed, and a source must stay saved to count.
 */
export function attachIncomingRelations(r: Reader, view: CollectionView): void {
  const graph = view.graph
  const root = graph?.entities.find((e) => e.key === graph.root)?.id
  if (!root) return
  const rows = r.db.all<{
    type: string
    id: string
    version: string
    kind: string
    external: string
    data: string
    author_id: string | null
    author_version: string | null
    author_type: string | null
    author_external: string | null
    author_data: string | null
  }>(sql`
    WITH incoming AS (
      SELECT DISTINCT sv.entity_id AS source, rel.kind AS type
      FROM entity_versions tv
      JOIN revision_entities tr ON tr.entity_version_id = tv.id
      JOIN entity_relations rel ON rel.revision_id = tr.revision_id
        AND rel.target_key = tr.entity_key
      JOIN revisions rv ON rv.id = rel.revision_id
      JOIN library l ON l.collection_id = rv.collection_id
      JOIN revision_entities sr ON sr.revision_id = rel.revision_id
        AND sr.entity_key = rel.source_key
      JOIN entity_versions sv ON sv.id = sr.entity_version_id
      WHERE tv.entity_id = ${root} AND rel.kind IN ('reposted', 'quoted')
    ), latest AS (
      SELECT * FROM (
        SELECT incoming.source, v.id AS version, v.data, ref.revision_id,
          ref.entity_key,
          row_number() OVER (PARTITION BY incoming.source
            ORDER BY rv.created_at DESC, v.created_at DESC, rv.id DESC) AS n
        FROM (SELECT DISTINCT source FROM incoming) incoming
        -- The few sources drive; otherwise SQLite may scan every reference.
        CROSS JOIN entity_versions v ON v.entity_id = incoming.source
        JOIN revision_entities ref ON ref.entity_version_id = v.id
        JOIN revisions rv ON rv.id = ref.revision_id
        JOIN library l ON l.collection_id = rv.collection_id
      ) WHERE n = 1
    )
    SELECT incoming.type, e.id, latest.version, e.kind, e.external_id AS external,
      latest.data, ${sql.raw(AUTHOR_COLUMNS)}
    FROM incoming
    JOIN latest ON latest.source = incoming.source
    JOIN entities e ON e.id = incoming.source
    ${sql.raw(authorJoins('latest.revision_id', 'latest.entity_key'))}
    ORDER BY incoming.type, e.platform, e.kind, e.external_id`)
  if (!rows.length) return
  // Read the sources like a graph quoting each of them, so they link,
  // summarize and show current authors the way a quoted post does.
  const sources: GraphView = { root: '', entities: [], relations: [] }
  const incoming: IncomingRelation[] = rows.map((row, i) => {
    const entity: EntityView = {
      id: row.id,
      version_id: row.version,
      key: `incoming_${i}`,
      type: row.kind,
      external_id: row.external,
      data: parseJson(row.data),
    }
    sources.entities.push(entity)
    sources.relations.push({ source: '', target: entity.key, type: 'quoted' })
    const relation: IncomingRelation = { type: row.type, entity }
    if (row.author_id) {
      relation.author = {
        id: row.author_id,
        version_id: row.author_version!,
        key: `${entity.key}_author`,
        type: row.author_type!,
        external_id: row.author_external!,
        data: parseJson(row.author_data),
      }
      sources.entities.push(relation.author)
      sources.relations.push({
        source: entity.key,
        target: relation.author.key,
        type: AUTHORED_BY,
      })
    }
    return relation
  })
  linkSavedEntities(r, { graph: sources })
  // A saved quoting post shows its own media the way a quoted one does.
  const saved = savedPosts(r, [
    ...new Set(
      incoming
        .map((i) => i.entity.saved_collection_id)
        .filter((id): id is string => !!id),
    ),
  ])
  for (const relation of incoming) {
    const post = saved.get(relation.entity.saved_collection_id ?? '')
    if (!post) continue
    // A reposting account's saved collection is a profile with no content
    // media; the avatar it lent is all the account has to show.
    const avatars =
      relation.entity.assets?.filter((a) => a.purpose === 'avatar') ?? []
    const assets = [...avatars, ...post.assets]
    if (assets.length) relation.entity.assets = assets
    else delete relation.entity.assets
    relation.author ??= post.author
  }
  view.incoming_relations = incoming
}

/**
 * An entity at its newest version within saved content, as that revision
 * shows it, with the counts its capture saw.
 */
export function getEntity(r: Reader, id: string): EntityView {
  const row = r.db.get<{
    payload: string
    capture_id: string
    version: string
  }>(sql`
    SELECT r.payload, r.capture_id, ev.id AS version
    FROM entity_versions ev
    JOIN revision_entities re ON re.entity_version_id = ev.id
    JOIN revisions r ON r.id = re.revision_id
    JOIN library l ON l.collection_id = r.collection_id
    WHERE ev.entity_id = ${id}
    ORDER BY ev.created_at DESC, r.created_at DESC, r.id DESC
    LIMIT 1`)
  if (!row) throw new AppError('not_found')
  const view = hydrate(
    parseJson<Payload>(row.payload),
    assetsByCapture(r, [row.capture_id]).get(row.capture_id) ?? [],
  )
  applyMetrics(view.graph, captureMetrics(r, row.capture_id))
  const entity = view.graph?.entities.find(
    (e) => e.id === id && e.version_id === row.version,
  )
  if (!entity) throw new Error('missing stored entity snapshot')
  return entity
}
