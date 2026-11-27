// The agent API's reads. Each runs on a read thread (`worker.ts`) with its
// own read-only connection, never on the web process's event loop; tests
// run them in place (`inlineReads`). Inputs and results are plain JSON.
import { asc, ne, sql } from 'drizzle-orm'
import { optionsJson } from '#capture/options.ts'
import {
  recordDetail,
  recordNotes,
  type CaptureRecord,
} from '#capture/records.ts'
import { isUpdate, updateRecord } from '#capture/updates.ts'
import { listWatches, type WatchView } from '#capture/watches.ts'
import { accountSelections, connections, jobs } from '#db/schema.ts'
import { readJobControl } from '#jobs/control.ts'
import { PAUSABLE_TYPES } from '#jobs/queue.ts'
import { listTags } from '#library/annotations.ts'
import {
  listProfileChanges,
  type ProfileFieldChange,
} from '#library/changes.ts'
import { narrowedCounts } from '#library/counts.ts'
import { attachIncomingRelations } from '#library/entities.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import { countFolder } from '#library/folder-counts.ts'
import { listFolders } from '#library/folders.ts'
import { listsOf } from '#library/follow-graph.ts'
import { followCounts, listFollowChanges } from '#library/follows.ts'
import { authorKey, listCollections } from '#library/list.ts'
import { collectionsById, isUUID, listCounts } from '#library/read.ts'
import { listShares } from '#library/shares.ts'
import { invalid, notFound } from './errors.ts'
import {
  checkKeys,
  decodeCursor,
  describe,
  encodeCursor,
  findAccount,
  readSearch,
  savedAccount,
  type AgentReader,
  type Kind,
  type Params,
} from './query.ts'
import {
  annotationsOf,
  isAccount,
  shape,
  type ShapeOptions,
  type View,
} from './shape.ts'
import type { AssetView, CollectionView } from '#library/views.ts'

export const BATCH_MAX = 100
const LIMIT_MAX = 1000
const LIMIT = /^\d{1,4}$/

function limitOf(params: Params, fallback: number, max = LIMIT_MAX): number {
  const raw = params.limit?.[0]
  if (raw === undefined) return fallback
  const limit = Number(raw)
  if (!LIMIT.test(raw) || limit < 1 || limit > max)
    throw invalid(`limit must be a whole number from 1 to ${max}.`)
  return limit
}

/** Saved collections, read for display, in the order asked, of one kind. */
function load(
  r: AgentReader,
  ids: readonly string[],
  kind?: Kind,
): Map<string, CollectionView> {
  const out = new Map<string, CollectionView>()
  for (const [id, c] of collectionsById(r, ids)) {
    // Not in the library (any more): as if it never was.
    if (c.saved_at === undefined) continue
    const wanted = kind === 'accounts'
    if (kind && isAccount(c) !== wanted) continue
    out.set(id, c)
  }
  return out
}

function shaper(r: AgentReader, view: View, origin: string, ids: string[]) {
  const o: ShapeOptions = {
    view,
    origin,
    annotations: annotationsOf(r.db, ids),
  }
  return (c: CollectionView) => shape(c, o)
}

// --- Searches ---------------------------------------------------------------

export interface SearchInput {
  kind: Kind
  params: Params
  origin: string
}

function search(r: AgentReader, input: SearchInput) {
  const s = readSearch(r, input.kind, input.params)
  const inner = s.cursor ? decodeCursor(s.bound, s.cursor) : undefined
  const page = listCollections(r, s.filter, inner, s.narrow, s.size, s.extra)
  const toItem = shaper(
    r,
    s.view,
    input.origin,
    page.items.map((c) => c.id),
  )
  return {
    ...(s.parsed === undefined ? {} : { parsed: s.parsed }),
    applied: s.applied,
    items: page.items.map(toItem),
    // Counting reads every match; only the first page pays for it.
    ...(s.cursor
      ? {}
      : {
          total: narrowedCounts(r.db, s.filter, s.narrow ?? {}, s.extra).count,
        }),
    has_more: !!page.next_cursor,
    ...(page.next_cursor
      ? { next_cursor: encodeCursor(s.bound, page.next_cursor) }
      : {}),
  }
}

// --- By id ------------------------------------------------------------------

export interface GetInput {
  kind: Kind
  refs: string[]
  view: View
  origin: string
  /** For accounts named `@handle`. */
  platform?: string
}

/**
 * Posts or accounts by reference, in the order asked: `missing` lists those
 * the archive does not have (or that are the other kind).
 */
function get(r: AgentReader, input: GetInput) {
  if (input.refs.length > BATCH_MAX)
    throw invalid(`At most ${BATCH_MAX} ids per request.`)
  const refs = [...new Set(input.refs)]
  const ids = new Map<string, string>()
  for (const ref of refs) {
    if (input.kind === 'posts') {
      if (!isUUID(ref)) throw invalid(`${ref} is not a post id.`)
      ids.set(ref, ref.toLowerCase())
      continue
    }
    try {
      ids.set(ref, savedAccount(r, ref, input.platform))
    } catch (error) {
      if ((error as { code?: string }).code !== 'not_found') throw error
    }
  }
  const found = load(r, [...ids.values()], input.kind)
  const toItem = shaper(r, input.view, input.origin, [...found.keys()])
  const items = []
  const missing = []
  for (const ref of refs) {
    const c = found.get(ids.get(ref) ?? '')
    if (c) items.push(toItem(c))
    else missing.push(ref)
  }
  return { items, missing }
}

// --- Around a post ----------------------------------------------------------

const RELATED_MAX = 50

function context(r: AgentReader, input: { id: string; origin: string }) {
  if (!isUUID(input.id)) throw notFound()
  const id = input.id.toLowerCase()
  const post = load(r, [id], 'posts').get(id)
  if (!post) throw notFound()
  attachIncomingRelations(r, post)
  const incoming = post.incoming_relations ?? []
  const related = listCollections(
    r,
    { relatedTo: id },
    undefined,
    undefined,
    RELATED_MAX,
  )
  const quoting = incoming.filter((i) => i.type === 'quoted')
  const ids = [
    id,
    ...related.items.map((c) => c.id),
    ...quoting.flatMap((i) =>
      i.entity.saved_collection_id ? [i.entity.saved_collection_id] : [],
    ),
  ]
  const full = shaper(r, 'full', input.origin, ids)
  const compact = shaper(r, 'compact', input.origin, ids)
  const quotingPosts = load(
    r,
    quoting.flatMap((i) =>
      i.entity.saved_collection_id ? [i.entity.saved_collection_id] : [],
    ),
    'posts',
  )
  const ref = (e: (typeof incoming)[number]['entity']) => ({
    ...(e.saved_collection_id ? { id: e.saved_collection_id } : {}),
    key: authorKey({
      platform: e.type.split('.', 1)[0]!,
      kind: e.type,
      external: e.external_id,
    }),
    ...(typeof e.data.username === 'string' && e.data.username
      ? { handle: e.data.username }
      : {}),
    ...(typeof e.data.name === 'string' && e.data.name
      ? { name: e.data.name }
      : {}),
  })
  const shaped = full(post) as {
    quoted?: { id?: string }
    reposted?: { id?: string }
  }
  // Listed above already: what it quotes or reposts, and what quotes it.
  const shown = new Set([
    ...quotingPosts.keys(),
    ...[shaped.quoted?.id, shaped.reposted?.id].filter((x): x is string => !!x),
  ])
  return {
    post: shaped,
    quoted_by: quoting.map((i) => {
      const saved = quotingPosts.get(i.entity.saved_collection_id ?? '')
      return saved
        ? compact(saved)
        : {
            platform_id: i.entity.external_id,
            ...(i.author ? { author: ref(i.author) } : {}),
            text:
              typeof i.entity.data.text === 'string' ? i.entity.data.text : '',
          }
    }),
    // Reposts are seen on the reposting account's timeline.
    reposted_by: incoming
      .filter((i) => i.type === 'reposted')
      .map((i) =>
        i.entity.type.endsWith('.profile')
          ? ref(i.entity)
          : { ...ref(i.entity), kind: 'post' },
      ),
    related: related.items
      .filter((c) => !shown.has(c.id))
      .map((c) => ({ relation: c.relation_types ?? [], item: compact(c) })),
    related_more: !!related.next_cursor,
  }
}

// --- Around an account --------------------------------------------------------

function account(r: AgentReader, ref: string, platform?: string) {
  const found = findAccount(r, ref, platform)
  if (!found.collectionId) throw notFound(`The account ${ref} is not saved.`)
  const subject = r.db.get<{ id: string }>(
    sql`SELECT root_entity_id AS id FROM catalog WHERE collection_id = ${found.collectionId}`,
  )?.id
  const handle = r.db.get<{ handle: string | null }>(sql`
    SELECT v.data ->> 'username' AS handle FROM catalog k
    JOIN revision_entities re ON re.revision_id = k.revision_id AND re.is_root = 1
    JOIN entity_versions v ON v.id = re.entity_version_id
    WHERE k.collection_id = ${found.collectionId}`)?.handle
  return {
    id: found.collectionId,
    key: found.key,
    platform: found.identity.platform,
    subject,
    ref: {
      id: found.collectionId,
      key: found.key,
      ...(handle ? { handle } : {}),
    },
  }
}

const media = (origin: string, a: AssetView | undefined) => {
  const url = a?.url ?? a?.thumbnail_url ?? a?.remote_url
  return url?.startsWith('/') ? `${origin}${url}` : url
}

function fieldChange(origin: string, f: ProfileFieldChange) {
  switch (f.field) {
    case 'avatar':
    case 'banner':
      return {
        field: f.field,
        ...(f.before ? { before: media(origin, f.before) ?? null } : {}),
        ...(f.after ? { after: media(origin, f.after) ?? null } : {}),
      }
    case 'pinned': {
      const posts = (list: typeof f.before) =>
        list.map((p) => ({
          platform_id: p.id,
          ...(p.url ? { url: p.url } : {}),
          ...(p.collection_id ? { id: p.collection_id } : {}),
          ...(p.text ? { text: p.text } : {}),
        }))
      return { field: 'pinned', before: posts(f.before), after: posts(f.after) }
    }
    default:
      return f
  }
}

function history(
  r: AgentReader,
  input: { ref: string; params: Params; origin: string },
) {
  checkKeys(input.params, ['limit', 'platform'])
  const a = account(r, input.ref, input.params.platform?.[0])
  const changes = listProfileChanges(r, a.id, limitOf(input.params, 100))
  return {
    account: a.ref,
    items: changes.items.map((change) => ({
      observed_at: change.observed_at,
      ...(change.capture_id ? { capture_id: change.capture_id } : {}),
      changes: change.fields.map((f) => fieldChange(input.origin, f)),
    })),
    ...(changes.truncated ? { truncated: true } : {}),
  }
}

const RELATION_KEYS = ['rel', 'q', 'sort', 'order', 'size', 'cursor', 'view']

function relations(
  r: AgentReader,
  input: { ref: string; params: Params; origin: string; platform?: string },
) {
  checkKeys(input.params, [...RELATION_KEYS, 'platform'])
  const rel = input.params.rel?.[0]
  if (!rel || !['following', 'followers', 'mutual'].includes(rel))
    throw invalid('rel must be one of: following, followers, mutual.')
  const a = account(r, input.ref, input.params.platform?.[0])
  const { platform: _, ...params } = input.params
  const page = search(r, {
    kind: 'accounts',
    origin: input.origin,
    params: {
      ...params,
      rel_of: [a.key],
      platform: [a.platform],
      sort: params.sort ?? ['followers'],
    },
  })
  return {
    account: a.ref,
    rel,
    counts: followCounts(r, a.id),
    lists: a.subject ? listsOf(r, a.subject) : { following: {}, followers: {} },
    ...page,
  }
}

function relationChanges(
  r: AgentReader,
  input: { ref: string; params: Params; origin: string },
) {
  checkKeys(input.params, ['limit', 'platform'])
  const a = account(r, input.ref, input.params.platform?.[0])
  const changes = listFollowChanges(r, a.id, limitOf(input.params, 100))
  return {
    account: a.ref,
    lists: a.subject ? listsOf(r, a.subject) : { following: {}, followers: {} },
    items: changes.items.map((change) => ({
      type: change.type,
      observed_at: change.observed_at,
      ...(change.since ? { since: change.since } : {}),
      account: {
        ...(change.account.collection_id
          ? { id: change.account.collection_id }
          : {}),
        key: authorKey({
          platform: a.platform,
          kind: `${a.platform}.profile`,
          external: change.account.external_id,
        }),
        ...(change.account.username ? { handle: change.account.username } : {}),
        ...(change.account.name ? { name: change.account.name } : {}),
      },
    })),
    ...(changes.truncated ? { truncated: true } : {}),
  }
}

/** `/metadata/followers` → `followers`. */
const metricName = (pointer: string) => pointer.split('/').at(-1)!

function metrics(
  r: AgentReader,
  input: { ref: string; kind: Kind; params: Params },
) {
  checkKeys(input.params, ['limit', 'platform'])
  const id =
    input.kind === 'accounts'
      ? account(r, input.ref, input.params.platform?.[0]).id
      : isUUID(input.ref) && load(r, [input.ref.toLowerCase()], 'posts').size
        ? input.ref.toLowerCase()
        : undefined
  if (!id) throw notFound()
  const series = listCounts(r, id, limitOf(input.params, 1000))
  return {
    id,
    ...(series.entity_type ? { entity_type: series.entity_type } : {}),
    points: series.points.map((p) => ({
      observed_at: p.observed_at,
      ...Object.fromEntries(
        Object.entries(p.counts).map(([pointer, n]) => [
          metricName(pointer),
          n,
        ]),
      ),
    })),
    ...(series.truncated ? { truncated: true } : {}),
  }
}

// --- The rest -----------------------------------------------------------------

function foldersOf(r: AgentReader) {
  const all = listFolders(r.db)
  // Null before the folder's first count.
  const kinds = (types: Record<string, number> | null, kind: Kind) =>
    types &&
    Object.entries(types)
      .filter(([type]) => r.types[kind].includes(type))
      .reduce((sum, [, n]) => sum + n, 0)
  return {
    items: all.map((f) => {
      const { filter } = parseFilterQuery(f.filter)
      return {
        id: f.id,
        name: f.name,
        filter: {
          ...describe(r, filter),
          ...(filter.sort ? { sort: filter.sort } : {}),
          ...(filter.order ? { order: filter.order } : {}),
        },
        posts: kinds(f.types, 'posts'),
        accounts: kinds(f.types, 'accounts'),
        counted_at: f.counted_at,
        stale: f.stale,
        created_at: f.created_at,
        updated_at: f.updated_at,
      }
    }),
  }
}

function tagsOf(r: AgentReader) {
  const counts = new Map(
    r.db
      .all<{ id: string; n: number }>(
        sql`SELECT tag_id AS id, count(*) AS n FROM collection_tags GROUP BY tag_id`,
      )
      .map((row) => [row.id, row.n]),
  )
  return {
    items: listTags(r.db).map((t) => ({
      id: t.id,
      name: t.name,
      collections: counts.get(t.id) ?? 0,
    })),
  }
}

function recordJson(
  r: CaptureRecord & { update?: unknown },
  notes: { url: string; note: string }[],
) {
  return {
    id: r.id,
    kind: 'update' in r ? 'update' : 'capture',
    state: r.state,
    done: r.done,
    url: r.url,
    ...(r.collectionId ? { collection_id: r.collectionId } : {}),
    created_at: r.createdAt.toISOString(),
    ...(r.finishedAt ? { finished_at: r.finishedAt.toISOString() } : {}),
    ...(r.waiting ? { waiting: r.waiting } : {}),
    // A complete capture's error is a note, listed with the others.
    ...(r.error && r.state !== 'complete' ? { error: r.error } : {}),
    ...(notes.length
      ? { notes: notes.map((n) => ({ url: n.url, text: n.note })) }
      : {}),
    ...(r.stopped ? { stopped: true } : {}),
    ...(r.paused ? { paused: true } : {}),
    ...(r.pausedAll ? { paused_all: true } : {}),
    ...(r.members
      ? {
          progress: {
            total: r.members.total,
            complete: r.members.complete,
            partial: r.members.partial,
            failed: r.members.failed,
            pending: r.members.pending,
            ...(r.members.added === undefined
              ? {}
              : { added: r.members.added, updated: r.members.updated }),
          },
        }
      : {}),
    media: r.media,
    ...(r.relations
      ? {
          relations: r.relations.map((l) => ({
            list: l.list,
            state: l.state,
            fetched: l.fetched,
            ...(l.expected === undefined ? {} : { expected: l.expected }),
          })),
        }
      : {}),
  }
}

/** A capture's or an update's progress. */
function status(r: AgentReader, input: { id: string }) {
  if (!isUUID(input.id)) throw notFound()
  const id = input.id.toLowerCase()
  if (isUpdate(r.db, id)) {
    const u = updateRecord(r.db, id)
    return {
      ...recordJson(u, recordNotes(r.db, id, true)),
      update: {
        target: u.update.target,
        ...(u.update.targetId ? { target_id: u.update.targetId } : {}),
        posts: u.update.posts,
        accounts: u.update.profiles,
        queued: u.update.queued,
        skipped: u.update.skipped,
      },
    }
  }
  return recordJson(recordDetail(r.db, id), recordNotes(r.db, id, false))
}

function queue(r: AgentReader) {
  const control = readJobControl(r.db)
  return {
    paused: control.paused,
    paused_types: control.types,
    pausable_types: [...PAUSABLE_TYPES],
    backlog: r.db.all<{
      type: string
      waiting: number
      running: number
      paused: number
    }>(
      sql`SELECT ${jobs.type} AS type,
          count(*) FILTER (WHERE ${jobs.state} = 'available') AS waiting,
          count(*) FILTER (WHERE ${jobs.state} = 'running') AS running,
          count(*) FILTER (WHERE ${jobs.state} = 'paused') AS paused
        FROM ${jobs} GROUP BY ${jobs.type} ORDER BY ${jobs.type}`,
    ),
  }
}

/** 定期更新: scheduled updates of an account or a folder. */
function watchJson(w: WatchView) {
  return {
    id: w.id,
    target: w.target === 'folder' ? 'folder' : 'account',
    target_id: w.targetId,
    ...(w.name ? { name: w.name } : {}),
    ...(w.handle ? { handle: w.handle } : {}),
    ...(w.url ? { url: w.url } : {}),
    every: { count: w.every.count, unit: w.every.unit },
    time_zone: w.timeZone,
    options: optionsJson(w.options),
    enabled: w.enabled,
    next_run_at: w.nextRunAt.toISOString(),
    ...(w.error ? { error: w.error } : {}),
    created_at: w.createdAt.toISOString(),
    ...(w.lastRun
      ? {
          last_run: {
            update_id: w.lastRun.id,
            state: w.lastRun.state,
            done: w.lastRun.done,
            ...(w.lastRun.paused ? { paused: true } : {}),
            ...(w.lastRun.stopped ? { stopped: true } : {}),
            created_at: w.lastRun.createdAt.toISOString(),
          },
        }
      : {}),
  }
}

function watchesOf(r: AgentReader, input: { id?: string } = {}) {
  return {
    items: listWatches(r.db, input.id ? { id: input.id } : {}).map(watchJson),
  }
}

/**
 * Public links (公开分享), all of them or those that make a post or account
 * public (`of`): its own, a folder holding it, a shared account listing it.
 */
function sharesOf(r: AgentReader, input: { of?: string; origin: string }) {
  const shares = listShares(r.db, input.of?.toLowerCase())
  const kinds = new Map(
    r.db
      .all<{ id: string; kind: string | null }>(
        sql`SELECT collection_id AS id, root_kind AS kind FROM catalog
          WHERE collection_id IN (SELECT value FROM json_each(${JSON.stringify(
            shares.map((s) => s.target_id),
          )}))`,
      )
      .map((row) => [row.id, row.kind]),
  )
  return {
    items: shares.map((share) => ({
      id: share.id,
      url: `${input.origin}/app/s/${share.slug}`,
      target:
        share.target === 'folder'
          ? 'folder'
          : kinds.get(share.target_id)?.endsWith('.profile')
            ? 'account'
            : 'post',
      target_id: share.target_id,
      ...(share.name ? { name: share.name } : {}),
      created_at: share.created_at,
    })),
  }
}

/** The owner's capture accounts (采集账号), without their credentials. */
function captureAccountsOf(r: AgentReader) {
  const selected = new Set(
    r.db
      .select({ id: accountSelections.connectionId })
      .from(accountSelections)
      .all()
      .map((row) => row.id),
  )
  return {
    items: r.db
      .select()
      .from(connections)
      .where(ne(connections.state, 'revoked'))
      .orderBy(asc(connections.name), asc(connections.id))
      .all()
      .map((c) => ({
        id: c.id,
        platform: c.adapterId,
        name: c.name,
        ...(c.username ? { username: c.username } : {}),
        state: c.state,
        selected: selected.has(c.id),
      })),
  }
}

/** Every read, by name. */
export const READS = {
  search,
  get,
  context,
  history,
  relations,
  relationChanges,
  metrics,
  folders: foldersOf,
  // A folder just made or changed, counted for the write that did it.
  folderCounts: (r: AgentReader, input: { id: string }) =>
    countFolder(r.db, input.id) ?? null,
  tags: tagsOf,
  status,
  queue,
  watches: watchesOf,
  shares: sharesOf,
  captureAccounts: captureAccountsOf,
} satisfies Record<string, (r: AgentReader, input: never) => unknown>

export type ReadName = keyof typeof READS
export type ReadInput<N extends ReadName> = Parameters<(typeof READS)[N]>[1]
export type ReadOutput<N extends ReadName> = Awaited<
  ReturnType<(typeof READS)[N]>
>

/** Run a read by name; what a read thread and `inlineReads` both call. */
export function runRead(r: AgentReader, name: string, input: unknown): unknown {
  if (!Object.hasOwn(READS, name)) throw new Error(`no read ${name}`)
  return (
    READS[name as ReadName] as (r: AgentReader, input: unknown) => unknown
  )(r, input)
}
