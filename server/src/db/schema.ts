import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTableCreator,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import type { IdentityInput } from '#capture/identity.ts'
import type { CaptureOptions, StoredOptions } from '#capture/options.ts'
import type { Metrics, Payload } from '#capture/payload.ts'
import type { StoredTarget } from '#capture/related.ts'
import type { VideoRemovalEffect } from '#library/video-removal.ts'
import type { Buffer } from 'node:buffer'

// Columns are declared in camelCase and stored in snake_case.
const sqliteTable = sqliteTableCreator((name) => name, 'snake_case')

const timestamp = () => integer({ mode: 'timestamp_ms' })
const createdAt = () =>
  timestamp()
    .notNull()
    .$defaultFn(() => new Date())
const bool = () => integer({ mode: 'boolean' })

/**
 * Durable background work. A row exists only while the job is pending or
 * running; finished jobs are deleted, and their outcome lives on the records
 * they worked on.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    // The record the job works on, interpreted by the job type's handler.
    ref: text().notNull(),
    queue: text().notNull(),
    // Lower runs first within a queue: the handler's own priority plus the
    // origin's rank (manual, update, watch, maintenance; `#jobs/queue.ts`).
    priority: integer().notNull().default(0),
    // `paused` while its update is paused (`updates.paused_at`); the worker
    // claims only `available` jobs.
    state: text({ enum: ['available', 'running', 'paused'] })
      .notNull()
      .default('available'),
    attempt: integer().notNull().default(0),
    maxAttempts: integer().notNull(),
    runAt: timestamp().notNull(),
    leaseUntil: timestamp(),
    lastError: text().notNull().default(''),
    createdAt: timestamp().notNull(),
    // The update (更新) whose work this is, inherited from the job that
    // enqueued it; pausing the update pauses these.
    updateId: text(),
    // The rate limit (`rate_limits.scope`) the job waits for, its `run_at`
    // the limit's end; cleared when the job next fails or snoozes.
    rateScope: text(),
  },
  (t) => [
    // Also how expired leases are found: running jobs are few, and naming
    // every queue reaches them through it (`#jobs/queue.ts`), so no index
    // of their own is updated on every claim and finish.
    index('jobs_claim').on(t.queue, t.state, t.priority, t.runAt),
    index('jobs_ref').on(t.ref),
    index('jobs_update')
      .on(t.updateId)
      .where(sql`${t.updateId} IS NOT NULL`),
    index('jobs_rate_scope')
      .on(t.rateScope)
      .where(sql`${t.rateScope} IS NOT NULL`),
  ],
)

/**
 * APIs that rate-limited us, by scope (`#jobs/rate-limits.ts`): the jobs
 * that ask one wait until `until`, without using an attempt. A row stays
 * after it ends; the next limit of the scope starts over.
 */
export const rateLimits = sqliteTable('rate_limits', {
  // `fxtwitter:public`, `x:session:<connection>:<endpoint>`,
  // `instagram:session:<connection>`.
  scope: text().primaryKey(),
  until: timestamp().notNull(),
  // What the platform said, e.g. `HTTP 429`.
  reason: text().notNull(),
  // Rate-limited answers since the limit started.
  hits: integer().notNull(),
  since: timestamp().notNull(),
})

/** What a platform says of content that is gone: see `collectionStates`. */
export const sourceStates = ['deleted', 'suspended'] as const

/** One object on a platform (a post, a profile), however it was captured. */
export const collections = sqliteTable(
  'collections',
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    kind: text().notNull(),
    objectScope: text().notNull().default(''),
    externalId: text().notNull(),
    url: text().notNull(),
    providerId: text().notNull(),
    // Newest revision; "head" is always the newest by (created_at, id).
    currentRevision: text(),
    // When nothing saved it any more; maintenance removes it after that.
    unreferencedAt: timestamp(),
    createdAt: createdAt(),
    observedAt: createdAt(),
    // The confirmed state on the platform (see `collectionStates`), and
    // since when: 原帖已删除, 账号已被封禁, 账号已不存在.
    sourceState: text({ enum: sourceStates }),
    sourceStateAt: timestamp(),
  },
  (t) => [
    uniqueIndex('collections_identity').on(
      t.platform,
      t.kind,
      t.objectScope,
      t.externalId,
    ),
    index('collections_unreferenced')
      .on(t.unreferencedAt)
      .where(sql`${t.unreferencedAt} IS NOT NULL`),
    // The library's filter on it reads only the few that have one.
    index('collections_source_state')
      .on(t.sourceState)
      .where(sql`${t.sourceState} IS NOT NULL`),
  ],
)

/**
 * Each time a collection was found gone on its platform: deleted, or its
 * account suspended. A first answer that is not explicit waits for a second
 * one (`confirmedAt` empty) and is dropped when the content comes back
 * first; a confirmed one ends (`endedAt`) once the content is read again.
 */
export const collectionStates = sqliteTable(
  'collection_states',
  {
    id: text().primaryKey(),
    collectionId: text()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    state: text({ enum: sourceStates }).notNull(),
    // The first capture that saw it.
    since: timestamp().notNull(),
    // When an agreeing second answer, or an explicit first one, came.
    confirmedAt: timestamp(),
    // The latest capture that saw it.
    seenAt: timestamp().notNull(),
    endedAt: timestamp(),
  },
  (t) => [index('collection_states_collection').on(t.collectionId, t.since)],
)

/** An external id that a fetch revealed to be another name of a collection. */
export const collectionIdentityAliases = sqliteTable(
  'collection_identity_aliases',
  {
    platform: text().notNull(),
    kind: text().notNull(),
    objectScope: text().notNull(),
    externalId: text().notNull(),
    collectionId: text()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.platform, t.kind, t.objectScope, t.externalId] }),
    index('collection_identity_aliases_collection').on(t.collectionId),
  ],
)

/**
 * Collections in the library, with the source that saved them (reused when
 * refreshing). Every non-refresh submission saves its target.
 */
export const library = sqliteTable(
  'library',
  {
    collectionId: text()
      .primaryKey()
      .references(() => collections.id, { onDelete: 'cascade' }),
    providerId: text().notNull(),
    connectionId: text(),
    adapterId: text().notNull(),
    note: text().notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('library_created').on(t.createdAt, t.collectionId)],
)

/** Above any real count, where an unknown one sorts from the bottom. */
const UNKNOWN_LAST = String(Number.MAX_SAFE_INTEGER)

/**
 * One row whose `n` moves whenever what a library filter selects may have
 * changed: the triggers of migration `library_version` count every write to
 * the catalog's filtered columns, the library, tags on collections, follow
 * edges and source states. Counts of the folders and the lists are kept
 * while it stays (`library/counts.ts`), whatever else is written (jobs,
 * media, observation times).
 */
export const libraryVersion = sqliteTable('library_version', {
  id: integer().primaryKey(),
  n: integer().notNull().default(0),
})

/**
 * What the library list filters and sorts on, one row per collection with a
 * revision, derived from its newest revision (see `library/catalog.ts`).
 * Facts that depend on other collections (the author's newest profile, tags
 * on the author, reposts by saved collections) are looked up when listing.
 */
export const catalog = sqliteTable(
  'catalog',
  {
    /**
     * The key of the search indexes (`catalog_fts`, `catalog_cjk`). An
     * INTEGER PRIMARY KEY is the rowid itself, which VACUUM keeps; the
     * implicit rowid of a table without one it may renumber.
     */
    id: integer().primaryKey(),
    collectionId: text()
      .notNull()
      .unique()
      .references(() => collections.id, { onDelete: 'cascade' }),
    revisionId: text().notNull(),
    revisionAt: integer().notNull(),
    observedAt: integer().notNull(),
    /** Publication time, or `observedAt` when the source gave none. */
    publishedAt: integer().notNull(),
    storageBytes: integer().notNull(),
    /** The root entity and its type; null without an entity graph. */
    rootEntityId: text(),
    rootKind: text(),
    /** The entity the root is authored by (the first by key). */
    authorEntityId: text(),
    authorName: text().notNull(),
    /** Whose account this is about: the author, or the root itself. */
    subjectEntityId: text(),
    /** Whether that account was protected in this revision; null if unknown. */
    subjectProtected: integer({ mode: 'boolean' }),
    /** Content media (no purpose), by what was stored. */
    hasMedia: integer({ mode: 'boolean' }).notNull(),
    hasImage: integer({ mode: 'boolean' }).notNull(),
    hasVideo: integer({ mode: 'boolean' }).notNull(),
    hasSensitive: integer({ mode: 'boolean' }).notNull(),
    /** The root quotes another post. */
    quotes: integer({ mode: 'boolean' }).notNull(),
    /**
     * What search reads, folded (`library/search-text.ts`) and indexed by
     * the `catalog_fts` table, which triggers keep in step: the author's or
     * account's name and `@handle` (one per line), the post's text, the text
     * and author of the posts it quotes or reposts, and media descriptions
     * with an account's bio.
     */
    searchName: text().notNull().default(''),
    searchText: text().notNull().default(''),
    searchQuoted: text().notNull().default(''),
    searchExtra: text().notNull().default(''),
    /**
     * An account's own counts as its newest capture with counts read them;
     * null for posts and when unknown.
     */
    followersCount: integer(),
    followingCount: integer(),
    /**
     * The language of the item's own text (post text, account bio) as
     * `lang/detect.ts` detects it, a BCP 47 tag: `ja`, `en`, `zh-Hans`,
     * `zh-Hant`, `zh` (Chinese of no telling script)…; null when it cannot
     * tell. Written with the side tables below, only when the revision
     * changes, and filled for older rows by maintenance.
     */
    lang: text(),
    // The counts as the list orders them, unknown last either way: below
    // every count from the top, above every count from the bottom. Real
    // columns rather than expression indexes, which SQLite cannot seek a
    // (key, id) cursor in.
    followersDesc: integer().generatedAlwaysAs(
      sql`coalesce(followers_count, -1)`,
      { mode: 'virtual' },
    ),
    followersAsc: integer().generatedAlwaysAs(
      sql`coalesce(followers_count, ${sql.raw(UNKNOWN_LAST)})`,
      { mode: 'virtual' },
    ),
    followingDesc: integer().generatedAlwaysAs(
      sql`coalesce(following_count, -1)`,
      { mode: 'virtual' },
    ),
    followingAsc: integer().generatedAlwaysAs(
      sql`coalesce(following_count, ${sql.raw(UNKNOWN_LAST)})`,
      { mode: 'virtual' },
    ),
  },
  (t) => [
    index('catalog_observed').on(t.observedAt, t.collectionId),
    index('catalog_published').on(t.publishedAt, t.collectionId),
    index('catalog_storage').on(t.storageBytes, t.collectionId),
    index('catalog_followers_desc').on(t.followersDesc, t.collectionId),
    index('catalog_followers_asc').on(t.followersAsc, t.collectionId),
    index('catalog_following_desc').on(t.followingDesc, t.collectionId),
    index('catalog_following_asc').on(t.followingAsc, t.collectionId),
    index('catalog_root').on(t.rootEntityId),
    // Covers the author list, which reads every saved row.
    index('catalog_author').on(
      t.authorEntityId,
      t.authorName,
      t.revisionAt,
      t.revisionId,
      t.collectionId,
    ),
    index('catalog_subject').on(t.subjectEntityId, t.revisionAt, t.revisionId),
  ],
)

/**
 * What a catalogued item's newest revision says, one row per value, for the
 * query language (`#tag`, `mentions:`, `domain:`) and aggregation
 * (`library/facets.ts`): hashtags folded (NFKC, lower case), mentioned
 * handles as `<platform>:<handle>` in lower case, and the registrable
 * domains its links point at. Keyed by value first so an atom reads one
 * index range; the catalog id index serves rewriting a row's values and the
 * cascade. The migration makes them WITHOUT ROWID (Drizzle cannot say so),
 * so each is two b-trees, not three.
 *
 * Written only when a row's revision changes (an unchanged capture writes
 * nothing here), and only the values that differ. They do not move
 * `library_version`: no folder can select by them yet.
 */
const facetTable = (name: string) =>
  sqliteTable(
    name,
    {
      catalogId: integer()
        .notNull()
        .references(() => catalog.id, { onDelete: 'cascade' }),
      value: text().notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.value, t.catalogId] }),
      index(`${name}_catalog`).on(t.catalogId),
    ],
  )

export const postHashtags = facetTable('post_hashtags')
export const postMentions = facetTable('post_mentions')
export const postDomains = facetTable('post_domains')

export const captureStates = [
  'queued',
  'downloading',
  'complete',
  'partial',
  'failed',
] as const
export type CaptureState = (typeof captureStates)[number]

/** One fetch of a collection; also the "job" users see. */
export const captures = sqliteTable(
  'captures',
  {
    id: text().primaryKey(),
    collectionId: text()
      .notNull()
      .references(() => collections.id),
    providerId: text().notNull(),
    adapterId: text().notNull(),
    connectionId: text(),
    // connections.revision used for the fetch; later steps abort if it moved.
    credentialRevision: integer(),
    // The saved collection this capture refreshes.
    refreshFrom: text(),
    // `public` or `connection:<id>`, passed to the platform.
    scope: text().notNull(),
    state: text({ enum: captureStates }).notNull().default('queued'),
    error: text().notNull().default(''),
    adapterVersion: text().notNull().default(''),
    createdAt: createdAt(),
    finishedAt: timestamp(),
    // The revision this capture produced or found unchanged.
    revisionId: text(),
    automatic: bool().notNull().default(false),
    pageSize: integer().notNull().default(0),
    pageCursor: text().notNull().default(''),
    nextPageCursor: text().notNull().default(''),
    isCollection: bool().notNull().default(false),
    maxBatchSize: integer().notNull().default(0),
  },
  (t) => [
    index('captures_collection').on(t.collectionId, t.createdAt),
    // Identical requests in flight share one capture. A finished capture
    // downloading its failed media again (it has a revision) is not a fetch
    // to share.
    uniqueIndex('captures_one_active')
      .on(
        t.collectionId,
        t.adapterId,
        t.providerId,
        sql`coalesce(${t.connectionId}, '')`,
        t.pageCursor,
        t.pageSize,
        t.automatic,
      )
      .where(
        sql`${t.state} IN ('queued', 'downloading') AND ${t.revisionId} IS NULL`,
      ),
    index('captures_active')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} IN ('queued', 'downloading')`),
    // Raw responses of finished captures are pruned by age.
    index('captures_finished')
      .on(t.finishedAt)
      .where(sql`${t.state} IN ('complete', 'partial')`),
  ],
)

// A capture row is written at its final size: what a capture learns later,
// or holds only while it runs, lives in the tables below, each row written
// once. Rows of `captures` that grew after their page filled split it, and
// staged bulk that went away left it mostly empty.

/**
 * What a capture holds only while it runs, removed once it is no longer
 * needed: the listing's prefetch until the fetch, the fetched result until
 * finalize, and the prefetches of the targets it lists until they are
 * submitted (see `capture/staging.ts`).
 */
export const captureStaging = sqliteTable('capture_staging', {
  captureId: text()
    .primaryKey()
    .references(() => captures.id, { onDelete: 'cascade' }),
  // What the listing that created the capture already read.
  prefetch: blob({ mode: 'buffer' }).$type<Buffer>(),
  // The fetched result, between the fetch and finalize.
  payload: text({ mode: 'json' }).$type<Payload>(),
  // Base64 prefetch of each listed target by position, null where none.
  targetPrefetch: text({ mode: 'json' }).$type<(string | null)[]>(),
})

/** What a fetch listed (members, references), written with its result. */
export const captureTargets = sqliteTable('capture_targets', {
  captureId: text()
    .primaryKey()
    .references(() => captures.id, { onDelete: 'cascade' }),
  targets: text({ mode: 'json' }).$type<StoredTarget[]>().notNull(),
})

/**
 * Counts a finished capture observed:
 * `{ "<type>/<externalId>": { "<pointer>": value } }`.
 */
export const captureMetrics = sqliteTable('capture_metrics', {
  captureId: text()
    .primaryKey()
    .references(() => captures.id, { onDelete: 'cascade' }),
  metrics: text({ mode: 'json' }).$type<Metrics>().notNull(),
})

// Written out rather than bound (`inArray` sends `IN (?, ?)`): SQLite only
// matches the partial indexes above against literal lists.
/** A capture still running. */
export const captureRunning = sql`${captures.state} IN ('queued', 'downloading')`
/** A capture that finished with something saved. */
export const captureSaved = sql`${captures.state} IN ('complete', 'partial')`

/** An immutable content snapshot of a collection, made by one capture. */
export const revisions = sqliteTable(
  'revisions',
  {
    id: text().primaryKey(),
    collectionId: text()
      .notNull()
      .references(() => collections.id),
    captureId: text()
      .notNull()
      .unique()
      .references(() => captures.id),
    contentHash: text().notNull(),
    /**
     * Digest of what a history point shows of this revision: revisions equal
     * here look the same, so the history folds them. Null until computed for
     * a revision made before it existed.
     */
    viewHash: text(),
    payload: text({ mode: 'json' }).notNull(),
    contentBytes: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('revisions_head').on(t.collectionId, t.createdAt, t.id),
    // Storage sums read sizes from here instead of rows carrying payloads.
    index('revisions_bytes').on(t.collectionId, t.contentBytes),
  ],
)

/** Platform objects seen inside revisions, shared across collections. */
export const entities = sqliteTable(
  'entities',
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    // The entity type, e.g. `x.post`.
    kind: text().notNull(),
    externalId: text().notNull(),
  },
  (t) => [
    uniqueIndex('entities_identity').on(t.platform, t.kind, t.externalId),
  ],
)

/** Distinct contents of an entity; the first stored data for a hash wins. */
export const entityVersions = sqliteTable(
  'entity_versions',
  {
    id: text().primaryKey(),
    entityId: text()
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    contentHash: text().notNull(),
    data: text({ mode: 'json' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('entity_versions_content').on(t.entityId, t.contentHash),
    // Which account went by a handle (`capture/stable-id.ts`); only accounts
    // have one, so posts' versions stay out of it.
    index('entity_versions_username')
      .on(sql`lower(${t.data} ->> '$.username')`)
      .where(sql`${t.data} ->> '$.username' IS NOT NULL`),
    // An entity's newest version, one seek (`capture/identity.ts`).
    index('entity_versions_newest').on(t.entityId, t.createdAt, t.id),
  ],
)

export const revisionEntities = sqliteTable(
  'revision_entities',
  {
    revisionId: text()
      .notNull()
      .references(() => revisions.id, { onDelete: 'cascade' }),
    entityKey: text().notNull(),
    entityVersionId: text()
      .notNull()
      .references(() => entityVersions.id),
    isRoot: bool().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.entityKey] }),
    uniqueIndex('revision_entities_root')
      .on(t.revisionId)
      .where(sql`${t.isRoot} = 1`),
    index('revision_entities_version').on(t.entityVersionId),
  ],
)

export const entityRelations = sqliteTable(
  'entity_relations',
  {
    revisionId: text()
      .notNull()
      .references(() => revisions.id, { onDelete: 'cascade' }),
    sourceKey: text().notNull(),
    targetKey: text().notNull(),
    kind: text().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.revisionId, t.sourceKey, t.kind, t.targetKey],
    }),
    // Reposts by saved collections, for the library's post type filter.
    index('entity_relations_kind').on(t.kind, t.revisionId),
  ],
)

export const relationLists = ['following', 'followers'] as const
/** Whose list: the accounts an account follows, or the ones following it. */
export type RelationList = (typeof relationLists)[number]

/**
 * A follow seen between two accounts, as an interval of observation: from
 * the first fetch that listed it to the last, until a complete fetch of a
 * list that should hold it no longer did (`endedAt`). A follow seen again
 * after it ended is a new row. Keyed by entity identity, so a follow seen
 * in either account's list is the same edge.
 */
export const followEdges = sqliteTable(
  'follow_edges',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    followerId: text()
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    followeeId: text()
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    firstSeenAt: timestamp().notNull(),
    lastSeenAt: timestamp().notNull(),
    endedAt: timestamp(),
  },
  (t) => [
    // One open interval per pair; also who an account follows now, and
    // the reverse look-up of mutual follows.
    uniqueIndex('follow_edges_open')
      .on(t.followerId, t.followeeId)
      .where(sql`${t.endedAt} IS NULL`),
    // Every interval of an account, open ones first by `ended_at IS NULL`.
    index('follow_edges_follower').on(t.followerId, t.endedAt, t.followeeId),
    index('follow_edges_followee').on(t.followeeId, t.endedAt, t.followerId),
  ],
)

export const relationFetchStates = [
  'waiting',
  'running',
  'complete',
  'partial',
  'skipped',
  'failed',
] as const
export type RelationFetchState = (typeof relationFetchStates)[number]

/**
 * One fetch of an account's following or followers list, asked for by a
 * profile capture (抓关系网). Only a `complete` one may end follows; the
 * newest complete one per account and list tells how fresh that list is.
 */
export const relationFetches = sqliteTable(
  'relation_fetches',
  {
    id: text().primaryKey(),
    // The request that asked; kept as history after it is gone.
    submissionId: text().references(() => submissions.id, {
      onDelete: 'set null',
    }),
    list: text({ enum: relationLists }).notNull(),
    // The account whose list this is, known once its profile was fetched.
    entityId: text().references(() => entities.id, { onDelete: 'cascade' }),
    state: text({ enum: relationFetchStates }).notNull().default('waiting'),
    // The list's size as the profile fetched in the same capture said.
    expected: integer(),
    // Distinct accounts listed so far.
    fetched: integer().notNull().default(0),
    pages: integer().notNull().default(0),
    cursor: text().notNull().default(''),
    providerId: text(),
    connectionId: text(),
    error: text().notNull().default(''),
    createdAt: createdAt(),
    startedAt: timestamp(),
    finishedAt: timestamp(),
  },
  (t) => [
    index('relation_fetches_submission').on(t.submissionId),
    index('relation_fetches_complete')
      .on(t.entityId, t.list, t.finishedAt)
      .where(sql`${t.state} = 'complete'`),
  ],
)

/**
 * Stored media bytes; the hash is also the media store key. Every blob is
 * written to the local media directory first; `remoteAt` records when its
 * upload to the remote store (R2) was confirmed. Only then does the web get
 * the public URL, and only then is the local file deleted, which leaves the
 * remote store with the only copy.
 */
export const blobs = sqliteTable(
  'blobs',
  {
    id: text().primaryKey(),
    hash: text().notNull().unique(),
    size: integer().notNull(),
    mime: text().notNull(),
    remoteAt: timestamp(),
    createdAt: createdAt(),
  },
  (t) => [index('blobs_size').on(t.size)],
)

/** A media item of a capture, at its position among the kept resources. */
export const assets = sqliteTable(
  'assets',
  {
    id: text().primaryKey(),
    captureId: text()
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    sourceUrl: text().notNull(),
    // '' for content media, otherwise a role such as `avatar`.
    purpose: text().notNull().default(''),
    altText: text().notNull().default(''),
    sensitive: bool().notNull().default(false),
    // What names this rendition for reuse across captures (sha256 of
    // [platform, immutable key]), stored only where it is not `media_key`:
    // NULL means the same as `media_key` (every X media; an Instagram one
    // whose key has no rendition), so the key is not kept twice. '' means
    // no immutable key, which is never reused (`media_key` is then
    // `url:<address>`). See `capture/media-key.ts` `cacheKey`.
    cacheKey: text(),
    // The media itself, whatever rendition was picked (see
    // `capture/media-key.ts`): what a removal mark names.
    mediaKey: text().notNull().default(''),
    kind: text({ enum: ['image', 'video'] }).notNull(),
    // `removed`: the owner removed the media (已移除); no blob, never fetched.
    state: text({ enum: ['pending', 'ready', 'failed', 'removed'] })
      .notNull()
      .default('pending'),
    error: text().notNull().default(''),
    blobId: text().references(() => blobs.id),
    // Pixel size of the media as the platform describes it, what the web
    // boxes it by before it loads; null when the platform did not say.
    width: integer(),
    height: integer(),
    // The platform's smaller rendition (an image's smaller size, a video's
    // poster) that the download stores as the blob's thumbnail; null when
    // there is none (an image then stands for itself).
    thumbnailUrl: text(),
  },
  (t) => [
    uniqueIndex('assets_position').on(t.captureId, t.position),
    // Rows whose `cache_key` is NULL (the same as `media_key`) are found with
    // `assets_media`; rows with a key of their own with this index.
    index('assets_cache')
      .on(t.cacheKey)
      .where(sql`${t.state} = 'ready' AND ${t.cacheKey} <> ''`),
    index('assets_blob').on(t.blobId),
    index('assets_media').on(t.mediaKey),
  ],
)

/**
 * Media the owner removed to save space (已移除), by media identity: every
 * capture that lists it, of any collection, skips downloading it until it
 * is restored (恢复). The mark holds the removed media's thumbnail so posts
 * still show it; media garbage spares a key still named here. It also
 * remembers the original's blob, so a restore within the grace period links
 * the file back without a download (`library/media-restore.ts`). A restore
 * after that downloads the original again; the row stays, `restore` set,
 * as the thumbnail shown meanwhile, and goes once the download succeeds.
 */
export const removedMedia = sqliteTable(
  'removed_media',
  {
    mediaKey: text().primaryKey(),
    kind: text({ enum: ['image', 'video'] }).notNull(),
    thumbnailKey: text(),
    thumbnailMime: text(),
    // The thumbnail's pixel size, as in `blobThumbnails`.
    thumbnailWidth: integer(),
    thumbnailHeight: integer(),
    // Its bytes, so 存储用量 still counts it; unknown for older marks.
    thumbnailSize: integer(),
    // When the thumbnail's upload to the remote store was confirmed, as in
    // `blobThumbnails`.
    thumbnailRemoteAt: timestamp(),
    // The original's blob as it was removed, to link it back while its file
    // is still there; null for marks made before these were kept, and when
    // nothing was downloaded.
    blobHash: text(),
    blobSize: integer(),
    blobMime: text(),
    blobRemoteAt: timestamp(),
    // Null while removed. `downloading`: restored, its original downloading
    // again (no longer skipped by captures); `failed`: that download failed
    // for good (`restoreError`), skipped again until the next restore.
    restore: text({ enum: ['downloading', 'failed'] }),
    // The asset whose download restores it, and so the collection whose
    // assets of this media come back with it.
    restoreAsset: text(),
    restoreError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('removed_media_thumbnail')
      .on(t.thumbnailKey)
      .where(sql`${t.thumbnailKey} IS NOT NULL`),
  ],
)

/**
 * 删除所有视频 of a profile: a job removes the videos of the posts that
 * deleting the profile with its posts would take (`library/video-removal.ts`).
 */
export const videoRemovals = sqliteTable(
  'video_removals',
  {
    id: text().primaryKey(),
    // The profile.
    collectionId: text()
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    state: text({ enum: ['queued', 'running', 'complete', 'failed'] })
      .notNull()
      .default('queued'),
    // What it removes, planned once when the job starts.
    effect: text({ mode: 'json' }).$type<VideoRemovalEffect>(),
    // Videos removed so far.
    removed: integer().notNull().default(0),
    error: text().notNull().default(''),
    createdAt: createdAt(),
    finishedAt: timestamp(),
  },
  (t) => [index('video_removals_collection').on(t.collectionId, t.createdAt)],
)

/**
 * A blob's thumbnail, downloaded from the platform with the original (see
 * `capture/thumbnail.ts`): one per blob; a failure is final.
 */
export const blobThumbnails = sqliteTable(
  'blob_thumbnails',
  {
    blobId: text()
      .primaryKey()
      .references(() => blobs.id, { onDelete: 'cascade' }),
    state: text({ enum: ['ready', 'failed'] }).notNull(),
    // Media store key (content hash) of the thumbnail.
    key: text(),
    size: integer(),
    mime: text(),
    // Pixel size of the thumbnail, in the original's proportions: what the
    // web reserves a box by before the media loads. Read from the file; null
    // for thumbnails made before sizes were kept, until read; 0 when the
    // file cannot be read.
    width: integer(),
    height: integer(),
    // When the file's upload to the remote store (R2) was confirmed: from
    // then on the web gets its public URL and the local file is gone, as
    // for originals (`blobs.remoteAt`). Null while it is only local.
    remoteAt: timestamp(),
    error: text().notNull().default(''),
    createdAt: createdAt(),
  },
  // Media garbage checks whether a key is still a thumbnail.
  (t) => [
    index('blob_thumbnails_key')
      .on(t.key)
      .where(sql`${t.key} IS NOT NULL`),
    // Thumbnails still to move to the remote store: none, once all have.
    index('blob_thumbnails_local')
      .on(t.key)
      .where(sql`${t.key} IS NOT NULL AND ${t.remoteAt} IS NULL`),
  ],
)

/**
 * Media store keys no longer referenced. Files are deleted after a grace
 * period, and only if nothing references the key again by then.
 */
export const mediaGarbage = sqliteTable('media_garbage', {
  key: text().primaryKey(),
  since: createdAt(),
  attempts: integer().notNull().default(0),
  retryAt: timestamp(),
  // Set by the worker's collection once it found the key unused and is
  // deleting the file: a restore in the web process (which shares no lock
  // with the worker) links a file back only while this is null.
  claimedAt: timestamp(),
})

/**
 * Raw upstream responses of a capture: what was fetched, its hash and size.
 * The bytes are in `source_response_bodies` while they are kept here; with
 * a raw bucket configured, each body moves there once the capture finished
 * (see `raw/`), compressed, under its hash, and its body row goes. A row
 * without a body row is in the bucket. Delete rows with
 * `deleteSourceResponses`, so that objects nothing uses any more go too.
 */
export const sourceResponses = sqliteTable(
  'source_responses',
  {
    id: text().primaryKey(),
    captureId: text()
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    contentType: text().notNull(),
    sourceUrl: text().notNull(),
    // Of the body as received, also the object's key.
    sha256: text().notNull(),
    size: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('source_responses_position').on(t.captureId, t.position),
    // Whether any row still uses an object, and whether one is stored.
    index('source_responses_sha256').on(t.sha256),
  ],
)

/**
 * The bytes of the raw responses kept in the database, byte for byte: all
 * of them without a raw bucket, else those not yet stored there (and ones
 * whose bytes do not match their hash). Storing a body in the bucket
 * deletes its row, which leaves the metadata in `source_responses` alone;
 * the rows here are the sweep's backlog.
 */
export const sourceResponseBodies = sqliteTable('source_response_bodies', {
  responseId: text()
    .primaryKey()
    .references(() => sourceResponses.id, { onDelete: 'cascade' }),
  body: blob({ mode: 'buffer' }).$type<Buffer>().notNull(),
})

/**
 * Raw responses whose upload job gave up: the sweep (`sweepRawUploads`)
 * queues them again after `retryAt`. A body that does not match its hash
 * is never retried (`retryAt` null). Gone once the row is stored.
 */
export const rawUploadFailures = sqliteTable('raw_upload_failures', {
  responseId: text()
    .primaryKey()
    .references(() => sourceResponses.id, { onDelete: 'cascade' }),
  // Times the job gave up on it.
  failures: integer().notNull(),
  retryAt: timestamp(),
  error: text().notNull(),
})

/**
 * Keys of raw response objects whose last row was deleted. They are
 * deleted from the bucket after a grace period, and only if no row uses
 * the key again by then.
 */
export const rawGarbage = sqliteTable('raw_garbage', {
  key: text().primaryKey(),
  since: createdAt(),
  attempts: integer().notNull().default(0),
  retryAt: timestamp(),
})

/**
 * A request for a capture: user input, a member of a collection page, or a
 * continuation page. Several can share one capture.
 */
export const submissions = sqliteTable(
  'submissions',
  {
    id: text().primaryKey(),
    captureId: text()
      .notNull()
      .references(() => captures.id),
    // Prefixes carry meaning, see .ai/capture-spec.md §3.2.3.
    idemKey: text().notNull().unique(),
    fingerprint: text().notNull(),
    input: text().notNull(),
    createdAt: createdAt(),
    relatedProvider: text().notNull().default(''),
    relatedConnection: text(),
    relatedAdapter: text().notNull().default(''),
    relatedSourceCollection: text(),
    relatedState: text({ enum: ['none', 'pending', 'complete', 'failed'] })
      .notNull()
      .default('none'),
    relatedError: text().notNull().default(''),
    // Remaining member budget of this page; 0 means none (or, with
    // options, no limit).
    collectionLimit: integer().notNull().default(0),
    nextSubmission: text(),
    collectionStopped: bool().notNull().default(false),
    parentSubmission: text(),
    // The run's options (see `StoredOptions`); null on rows predating them,
    // read as the defaults.
    captureOptions: text({ mode: 'json' }).$type<StoredOptions>(),
    // Whether the target had no saved content in the library when this
    // submission was made, i.e. it is 新增 rather than 更新. Recorded at
    // submit time because the library row it inserts makes that unknowable
    // later; null for submissions older than the column.
    libraryAdded: bool(),
    // The update (更新) this submission is an item of; its record is the
    // update's, not one of its own.
    updateId: text(),
    // A timeline page where `until_existing` ran into its post cap before
    // reaching saved posts; its capture's next cursor continues it.
    timelineCapped: bool().notNull().default(false),
  },
  (t) => [
    index('submissions_records')
      .on(t.createdAt, t.id)
      .where(sql`${t.parentSubmission} IS NULL AND ${t.input} <> ''`),
    index('submissions_capture').on(t.captureId),
    index('submissions_update')
      .on(t.updateId)
      .where(sql`${t.updateId} IS NOT NULL`),
    // Partial: top-level requests (no parent) are most rows, and indexing
    // them leads SQLite to read records through this index instead.
    index('submissions_parent')
      .on(t.parentSubmission)
      .where(sql`${t.parentSubmission} IS NOT NULL`),
  ],
)

/**
 * A request for a profile its link names only by its handle (X): nothing
 * is saved under a handle, so the platform first says whose it is (the
 * `identify` job). Identified, it becomes the submission with the same id
 * and the row goes; until then it is a record of its own, pending or
 * failed. With `collection_id`, it identifies a profile saved by its handle
 * before that rule, which maintenance folds into its account's
 * (`capture/identity.ts`).
 */
export const identityRequests = sqliteTable(
  'identity_requests',
  {
    id: text().primaryKey(),
    idemKey: text().notNull().unique(),
    adapterId: text().notNull(),
    // The link as resolved, with the handle as written.
    url: text().notNull(),
    handle: text().notNull(),
    input: text().notNull(),
    // What to submit once identified, but the link.
    request: text({ mode: 'json' }).$type<IdentityInput>().notNull(),
    parentSubmission: text(),
    updateId: text(),
    // Not a reference: the collection goes once folded.
    collectionId: text(),
    state: text({ enum: ['pending', 'failed'] })
      .notNull()
      .default('pending'),
    error: text().notNull().default(''),
    // Lookups made for a saved profile, which maintenance spaces out.
    attempts: integer().notNull().default(0),
    createdAt: createdAt(),
    finishedAt: timestamp(),
  },
  (t) => [
    index('identity_requests_records')
      .on(t.createdAt, t.id)
      .where(sql`${t.parentSubmission} IS NULL AND ${t.input} <> ''`),
    index('identity_requests_collection')
      .on(t.collectionId)
      .where(sql`${t.collectionId} IS NOT NULL`),
  ],
)

export const updateTargets = ['collection', 'folder', 'many'] as const
export type UpdateTarget = (typeof updateTargets)[number]
/**
 * One 更新: a saved collection, a folder or a selection, captured again as
 * a single record. Its captures are the submissions that name it.
 */
export const updates = sqliteTable(
  'updates',
  {
    id: text().primaryKey(),
    target: text({ enum: updateTargets }).notNull(),
    // The collection or folder updated; '' for a selection.
    targetId: text().notNull().default(''),
    // The folder's name when the update started.
    name: text().notNull().default(''),
    // What the target held when the update started, each once.
    collectionIds: text({ mode: 'json' }).$type<string[]>().notNull(),
    // What each item captures, as a link submission would.
    options: text({ mode: 'json' }).$type<CaptureOptions>().notNull(),
    // Profiles read on from the page after their last one (抓取更早的帖子).
    older: bool().notNull().default(false),
    // Items submitted (or skipped) so far, in order.
    position: integer().notNull().default(0),
    // Items gone from the library or no longer capturable when their turn came.
    skipped: integer().notNull().default(0),
    state: text({ enum: ['running', 'complete', 'stopped', 'failed'] })
      .notNull()
      .default('running'),
    error: text().notNull().default(''),
    // Set while paused: its jobs wait as `paused` and it submits no items.
    pausedAt: timestamp(),
    // A repeat of the same request starts nothing new.
    idemKey: text().unique(),
    // The watch (定期更新) that started it; its jobs rank below manual work.
    // `origin` stays when the watch is removed.
    origin: text({ enum: ['manual', 'watch'] })
      .notNull()
      .default('manual'),
    watchId: text().references((): AnySQLiteColumn => watches.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('updates_created').on(t.createdAt, t.id),
    index('updates_watch')
      .on(t.watchId, t.createdAt)
      .where(sql`${t.watchId} IS NOT NULL`),
  ],
)

/**
 * An update's members, kept as members come and go (`capture/progress.ts`):
 * one row per collection, of its newest capture, new if any listing of it
 * was. What the update's progress counts are made of; kept exact by the
 * worker from `member_events`, which triggers fill.
 */
export const updateMembers = sqliteTable(
  'update_members',
  {
    updateId: text().notNull(),
    collectionId: text().notNull(),
    captureId: text().notNull(),
    // The capture's own state; `known` is told apart when read.
    state: text().notNull(),
    added: bool(),
  },
  (t) => [
    primaryKey({ columns: [t.updateId, t.collectionId] }),
    index('update_members_state').on(t.updateId, t.state, t.added),
    index('update_members_capture').on(t.captureId),
  ],
)

/** The timeline pages of an update's profiles, each profile's chain. */
export const updatePages = sqliteTable(
  'update_pages',
  {
    pageId: text().primaryKey(),
    updateId: text().notNull(),
  },
  (t) => [index('update_pages_update').on(t.updateId)],
)

/** An update's members counted by their capture's state; one row each. */
export const updateProgress = sqliteTable('update_progress', {
  updateId: text().primaryKey(),
  total: integer().notNull(),
  complete: integer().notNull(),
  completeAdded: integer().notNull(),
  completeUpdated: integer().notNull(),
  partial: integer().notNull(),
  partialAdded: integer().notNull(),
  partialUpdated: integer().notNull(),
  failed: integer().notNull(),
  pending: integer().notNull(),
})

/**
 * What changed that an update's members may depend on, written by triggers
 * and taken up by the worker (`kind`: `s` a submission, `c` a capture, `u`
 * an update, `p` a page).
 */
export const memberEvents = sqliteTable(
  'member_events',
  {
    id: integer().primaryKey(),
    kind: text().notNull(),
    ref: text().notNull(),
  },
  (t) => [uniqueIndex('member_events_ref').on(t.kind, t.ref)],
)

/**
 * The counted view of a capture record (an update, or a request's record)
 * that has finished, kept so reading the list does not count its members
 * again (`capture/record-summaries.ts`). Written by the worker only; a row
 * is dropped when something changes the record, and is used only while its
 * `stamp` matches the record's own rows.
 */
export const recordSummaries = sqliteTable('record_summaries', {
  // The update's or the request's id.
  id: text().primaryKey(),
  stamp: text().notNull(),
  // The record as the list shows it.
  summary: text({ mode: 'json' }).notNull(),
  computedAt: createdAt(),
})

export const updateSkipReasons = [
  // No longer in the library.
  'removed',
  // Its platform cannot capture it (any more).
  'unsupported',
  // No usable account to capture it with.
  'account',
  // 抓取更早的帖子: the profile has no older posts.
  'no_more_pages',
  // Skipped before reasons were kept.
  'unknown',
] as const
export type UpdateSkipReason = (typeof updateSkipReasons)[number]

/** An item of an update that could not be captured when its turn came. */
export const updateSkips = sqliteTable(
  'update_skips',
  {
    updateId: text()
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    // Its place in `updates.collection_ids`.
    position: integer().notNull(),
    // Not a reference: the collection may be gone later.
    collectionId: text().notNull(),
    // Its link when skipped, to name it once the collection is gone.
    url: text().notNull().default(''),
    reason: text({ enum: updateSkipReasons }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.updateId, t.position] })],
)

/** What a watch's interval counts: every `count` of these. */
export const intervalUnits = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
] as const
export type IntervalUnit = (typeof intervalUnits)[number]

/**
 * 定期更新: a saved profile or a folder updated on a schedule, with options
 * of its own. Exactly one target; removing it removes the watch.
 */
export const watches = sqliteTable(
  'watches',
  {
    id: text().primaryKey(),
    collectionId: text().references(() => library.collectionId, {
      onDelete: 'cascade',
    }),
    folderId: text().references(() => folders.id, { onDelete: 'cascade' }),
    // Every `every_count` `every_unit`s (`capture/watch-schedule.ts`).
    everyCount: integer().notNull(),
    everyUnit: text({ enum: intervalUnits }).notNull(),
    // Months and years count in this zone (IANA), from the local day of
    // `anchor_at`: when the interval was last set.
    timeZone: text().notNull().default('UTC'),
    anchorAt: timestamp().notNull(),
    // What each run captures, as an update started by hand would.
    options: text({ mode: 'json' }).$type<CaptureOptions>().notNull(),
    enabled: bool().notNull().default(true),
    // The next slot: its interval from a fixed offset of its own, so
    // watches do not all start at once (`capture/watches.ts`).
    nextRunAt: timestamp().notNull(),
    // Why the last slot started nothing (the folder was empty, say).
    error: text().notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('watches_collection').on(t.collectionId),
    uniqueIndex('watches_folder').on(t.folderId),
    index('watches_due').on(t.enabled, t.nextRunAt),
    check(
      'watches_one_target',
      sql`(${t.collectionId} IS NULL) <> (${t.folderId} IS NULL)`,
    ),
  ],
)

export const tags = sqliteTable('tags', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
})

export const collectionTags = sqliteTable(
  'collection_tags',
  {
    collectionId: text()
      .notNull()
      .references(() => library.collectionId, { onDelete: 'cascade' }),
    tagId: text()
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.tagId] }),
    index('collection_tags_tag').on(t.tagId),
  ],
)

/**
 * Saved queries (收藏夹): a query of the query language (`#query/`) in its
 * canonical form, naming tags and folders by id so that renaming them
 * changes nothing (`library/folders.ts`); empty selects everything. With
 * the order its list keeps and the zone its relative dates count in.
 */
export const folders = sqliteTable('folders', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  query: text().notNull().default(''),
  sort: text().notNull().default(''),
  order: text().notNull().default(''),
  tz: text().notNull().default(''),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

/**
 * Each folder's counts as the worker last counted them (`library/folder-counts.ts`):
 * `/v1/folders` reads them rather than counting. `key` is what was counted
 * (the filter, with a relative save date resolved to its day), `version` the
 * `library_version` it was counted at; either moving makes the row stale.
 */
export const folderCounts = sqliteTable('folder_counts', {
  folderId: text()
    .primaryKey()
    .references(() => folders.id, { onDelete: 'cascade' }),
  key: text().notNull(),
  version: integer().notNull(),
  count: integer().notNull(),
  types: text({ mode: 'json' }).$type<Record<string, number>>().notNull(),
  countedAt: timestamp().notNull(),
})

/**
 * Public links (分享). The slug is random unless the owner sets one; whoever
 * has it reads what the target holds at that moment, a folder by its filter
 * or one saved collection. A slug is unique among live links only: once its
 * link is revoked, or moved to another slug, it may name a new link.
 */
export const shares = sqliteTable(
  'shares',
  {
    id: text().primaryKey(),
    slug: text().notNull(),
    targetKind: text({ enum: ['folder', 'collection'] }).notNull(),
    targetId: text().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp(),
  },
  (t) => [
    index('shares_target').on(t.targetKind, t.targetId),
    uniqueIndex('shares_slug_live')
      .on(t.slug)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
)

/** Platform accounts used for capturing. */
export const connections = sqliteTable(
  'connections',
  {
    id: text().primaryKey(),
    adapterId: text().notNull(),
    providerId: text().notNull(),
    name: text().notNull(),
    accountId: text(),
    username: text(),
    state: text({ enum: ['pending', 'ready', 'reauth_required', 'revoked'] })
      .notNull()
      .default('pending'),
    credentialRef: text(),
    // Bumped whenever the credential or state changes under a capture.
    revision: integer().notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('connections_account')
      .on(t.adapterId, t.providerId, t.accountId)
      .where(
        sql`${t.state} <> 'revoked' AND ${t.accountId} IS NOT NULL AND ${t.accountId} <> ''`,
      ),
  ],
)

/** Encrypted credentials (AES-256-GCM, see accounts/vault.ts). */
export const accountCredentials = sqliteTable('account_credentials', {
  id: text().primaryKey(),
  ciphertext: blob({ mode: 'buffer' }).$type<Buffer>().notNull(),
})

/** The account each platform captures with; null means anonymous. */
export const accountSelections = sqliteTable('account_selections', {
  adapterId: text().primaryKey(),
  connectionId: text(),
})

export const userRoles = ['admin', 'viewer'] as const
export type UserRole = (typeof userRoles)[number]

/**
 * Who signs in (docs/design/multi-user.md). The admin is the owner, made
 * from the single-user setup by the `users` migration, and there is only
 * one (`users_admin`); viewers come by invite and only read. Sessions,
 * passkeys and API tokens each belong to one user and go with them.
 */
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    /** Shown in the app; 1 to 32 characters. */
    name: text().notNull(),
    role: text({ enum: userRoles }).notNull(),
    /**
     * The WebAuthn user handle, base64url. An authenticator keeps one
     * passkey per RP ID and handle, so each user has their own: a shared
     * one would let a second user's passkey replace the admin's on a
     * synced keychain. The admin keeps `midden-owner`'s.
     */
    webauthnId: text().notNull().unique(),
    createdAt: createdAt(),
    /** Revoked: their credentials are gone and they cannot sign in. */
    revokedAt: timestamp(),
  },
  (t) => [
    uniqueIndex('users_admin')
      .on(t.role)
      .where(sql`${t.role} = 'admin'`),
  ],
)

/**
 * One-time links that register a new viewer, by the SHA-256 of their
 * token, which is shown once. The new user's WebAuthn handle is made with
 * the invite, so the options and the registration agree on it.
 */
export const invites = sqliteTable(
  'invites',
  {
    id: text().primaryKey(),
    digest: text().notNull().unique(),
    webauthnId: text().notNull().unique(),
    /** Who it is for; the admin's note. */
    label: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp().notNull(),
    usedAt: timestamp(),
    usedBy: text().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp(),
  },
  (t) => [index('invites_expires').on(t.expiresAt)],
)

const userId = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })

/**
 * Browser sessions, by the SHA-256 of the cookie value. `id` names one in
 * 设置 and the API, so the digest never leaves the server. The expiry
 * slides (`#http/sessions.ts`): a request more than a day after the last
 * renewal pushes it and `lastUsedAt` forward, so `lastUsedAt` is a day
 * coarse. Sessions from before the device list have no method, origin or
 * device.
 */
export const webSessions = sqliteTable(
  'web_sessions',
  {
    digest: text().primaryKey(),
    id: text().notNull().unique(),
    userId: userId(),
    expiresAt: timestamp().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp().notNull(),
    /** How it signed in. */
    method: text({ enum: ['passkey', 'telegram'] }),
    /** The web origin it signed in on; the cookie is that host's only. */
    origin: text(),
    /** Browser and system from the user agent, as `Safari · macOS`. */
    device: text(),
  },
  (t) => [
    index('web_sessions_expires').on(t.expiresAt),
    index('web_sessions_user').on(t.userId),
  ],
)

/**
 * API tokens (API 令牌), by the SHA-256 of the secret, which is shown once.
 * Rolling one replaces the digest and keeps the row, so its label,
 * permission and usage stay.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text().primaryKey(),
    digest: text().notNull().unique(),
    userId: userId(),
    label: text().notNull(),
    /** `ro` reads; `rw` also writes, except what deletes (owner session only). */
    permission: text({ enum: ['ro', 'rw'] })
      .notNull()
      .default('rw'),
    createdAt: createdAt(),
    /** Null: never expires. */
    expiresAt: timestamp(),
    /** Kept in memory and written with the usage counts, a minute late at most. */
    lastUsedAt: timestamp(),
  },
  (t) => [index('api_tokens_user').on(t.userId)],
)

/**
 * Requests made with each token, per UTC day (YYYY-MM-DD) and endpoint
 * (method and route pattern). The web process counts in memory and adds
 * its counts here about once a minute (`#tokens/usage.ts`).
 */
export const apiTokenUsage = sqliteTable(
  'api_token_usage',
  {
    tokenId: text()
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    day: text().notNull(),
    endpoint: text().notNull(),
    count: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.day, t.endpoint] })],
)

/**
 * Each user's passkeys. Each is bound to the RP ID (the host name) of the
 * domain it was created on and signs in only there.
 */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text().primaryKey(),
    // The credential id, base64url.
    credentialId: text().notNull().unique(),
    userId: userId(),
    rpId: text().notNull(),
    name: text().notNull(),
    publicKey: blob({ mode: 'buffer' }).$type<Buffer>().notNull(),
    counter: integer().notNull().default(0),
    // JSON array of the authenticator's transports, as it reported them.
    transports: text().notNull().default('[]'),
    createdAt: createdAt(),
    lastUsedAt: timestamp(),
  },
  (t) => [index('passkeys_rp').on(t.rpId), index('passkeys_user').on(t.userId)],
)

/**
 * Origins the web app is served on besides WEB_APP_URL's own. Cookie
 * sessions write and passkeys work only on these and that one.
 */
export const webOrigins = sqliteTable('web_origins', {
  id: text().primaryKey(),
  origin: text().notNull().unique(),
  createdAt: createdAt(),
})

/**
 * Server settings the owner edits in the web app's admin panel, and a few
 * values the server itself keeps across restarts. Values are text; the code
 * that reads a key parses it (`#settings.ts`).
 */
/**
 * Read-thread statements that took `SLOW_QUERY_MS` or longer
 * (`reads/slow.ts`), the newest `KEEP` of them: only slow ones are written,
 * and each write drops what is past the last `KEEP`.
 */
export const slowQueries = sqliteTable('slow_queries', {
  id: integer().primaryKey(),
  at: timestamp().notNull(),
  route: text().notNull(),
  query: text().notNull(),
  sql: text().notNull(),
  params: text().notNull(),
  ms: integer().notNull(),
  rows: integer().notNull(),
})

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
})

/**
 * Storage usage, one row per UTC day (`#usage/snapshots.ts`): R2 per bucket
 * from Cloudflare's analytics, and the local figures as last read that day.
 * A part is null when it was not read that day.
 */
export const storageSnapshots = sqliteTable('storage_snapshots', {
  // YYYY-MM-DD, UTC.
  day: text().primaryKey(),
  // JSON: { [bucket]: { bytes, objects, class_a, class_b } }, the day's
  // peak storage and its operations.
  r2: text({ mode: 'json' }).$type<Record<string, BucketDay>>(),
  dbBytes: integer(),
  thumbnailBytes: integer(),
  freeBytes: integer(),
  updatedAt: timestamp().notNull(),
})

/** One bucket on one day, in a storage snapshot. */
export interface BucketDay {
  /** Peak payload and metadata size that day; null without a reading. */
  bytes: number | null
  objects: number | null
  class_a: number
  class_b: number
}

/**
 * Links from the bot's /passkey that register a passkey without signing in,
 * by the SHA-256 of their token. One per origin; gone once used.
 */
export const passkeyTokens = sqliteTable(
  'passkey_tokens',
  {
    digest: text().primaryKey(),
    origin: text().notNull(),
    expiresAt: timestamp().notNull(),
  },
  (t) => [index('passkey_tokens_expires').on(t.expiresAt)],
)

/**
 * Messages the bot owes the owner: a capture's status and result, or a shown
 * collection. Progress is checkpointed per sent part, so a
 * restart resumes without resending.
 */
export const telegramDeliveries = sqliteTable(
  'telegram_deliveries',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['submission', 'update', 'show'] }).notNull(),
    // Submission or collection id.
    ref: text().notNull(),
    chatId: text().notNull(),
    group: bool().notNull().default(false),
    // In groups, replies go to the message that asked.
    replyTo: integer(),
    // The status or header message, edited in place.
    messageId: integer(),
    progress: integer().notNull().default(0),
    state: text({ enum: ['pending', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    nextAt: timestamp().notNull(),
    failures: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('telegram_deliveries_due').on(t.state, t.nextAt),
    index('telegram_deliveries_ref').on(t.ref),
    // Whether a pressed button sits on a delivery message.
    index('telegram_deliveries_message').on(t.chatId, t.messageId),
  ],
)

/** Telegram file ids of uploaded media, per bot, to avoid re-uploading. */
export const telegramMedia = sqliteTable(
  'telegram_media',
  {
    botId: text().notNull(),
    hash: text().notNull(),
    representation: text({ enum: ['photo', 'video', 'document'] }).notNull(),
    fileId: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.hash, t.representation] })],
)
