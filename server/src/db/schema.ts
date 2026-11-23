import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTableCreator,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
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
    // Lower runs first within a queue.
    priority: integer().notNull().default(0),
    state: text({ enum: ['available', 'running'] })
      .notNull()
      .default('available'),
    attempt: integer().notNull().default(0),
    maxAttempts: integer().notNull(),
    runAt: timestamp().notNull(),
    leaseUntil: timestamp(),
    lastError: text().notNull().default(''),
    createdAt: timestamp().notNull(),
  },
  (t) => [
    index('jobs_claim').on(t.queue, t.state, t.priority, t.runAt),
    index('jobs_ref').on(t.ref),
    // Expired leases are looked for every second.
    index('jobs_running')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'running'`),
  ],
)

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
    sourceState: text({ enum: ['deleted', 'suspended'] }),
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
  ],
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

/**
 * What the library list filters and sorts on, one row per collection with a
 * revision, derived from its newest revision (see `library/catalog.ts`).
 * Facts that depend on other collections (the author's newest profile, tags
 * on the author, reposts by saved collections) are looked up when listing.
 */
export const catalog = sqliteTable(
  'catalog',
  {
    collectionId: text()
      .primaryKey()
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
    /** Text, summary and author name, for substring search. */
    search: text().notNull(),
  },
  (t) => [
    index('catalog_observed').on(t.observedAt, t.collectionId),
    index('catalog_published').on(t.publishedAt, t.collectionId),
    index('catalog_storage').on(t.storageBytes, t.collectionId),
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
    // Staged result between the fetch and finalize.
    payload: text({ mode: 'json' }),
    adapterVersion: text().notNull().default(''),
    createdAt: createdAt(),
    finishedAt: timestamp(),
    // The revision this capture produced or found unchanged.
    revisionId: text(),
    automatic: bool().notNull().default(false),
    relatedTargets: text({ mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    pageSize: integer().notNull().default(0),
    pageCursor: text().notNull().default(''),
    nextPageCursor: text().notNull().default(''),
    isCollection: bool().notNull().default(false),
    maxBatchSize: integer().notNull().default(0),
    prefetch: blob({ mode: 'buffer' }).$type<Buffer>(),
    // Observed counts: { "<type>/<externalId>": { "<pointer>": value } }.
    metrics: text({ mode: 'json' }),
  },
  (t) => [
    index('captures_collection').on(t.collectionId, t.createdAt),
    // Identical requests in flight share one capture.
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
      .where(sql`${t.state} IN ('queued', 'downloading')`),
    index('captures_active')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} IN ('queued', 'downloading')`),
    // Raw responses of finished captures are pruned by age.
    index('captures_finished')
      .on(t.finishedAt)
      .where(sql`${t.state} IN ('complete', 'partial')`),
  ],
)

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
    payload: text({ mode: 'json' }).notNull(),
    contentBytes: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('revisions_head').on(t.collectionId, t.createdAt, t.id)],
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
    observedAt: createdAt(),
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
  (t) => [uniqueIndex('entity_versions_content').on(t.entityId, t.contentHash)],
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

/** Stored media bytes; the hash is also the media store key. */
export const blobs = sqliteTable('blobs', {
  id: text().primaryKey(),
  hash: text().notNull().unique(),
  size: integer().notNull(),
  mime: text().notNull(),
  createdAt: createdAt(),
})

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
    // sha256 of [platform, immutable key]: reuse across captures.
    cacheKey: text().notNull().default(''),
    kind: text({ enum: ['image', 'video'] }).notNull(),
    state: text({ enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    error: text().notNull().default(''),
    blobId: text().references(() => blobs.id),
  },
  (t) => [
    uniqueIndex('assets_position').on(t.captureId, t.position),
    index('assets_cache')
      .on(t.cacheKey)
      .where(sql`${t.state} = 'ready' AND ${t.cacheKey} <> ''`),
    index('assets_blob').on(t.blobId),
  ],
)

/** One thumbnail attempt per blob; a failure is final. */
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
    error: text().notNull().default(''),
    createdAt: createdAt(),
  },
  // Media garbage checks whether a key is still a thumbnail.
  (t) => [
    index('blob_thumbnails_key')
      .on(t.key)
      .where(sql`${t.key} IS NOT NULL`),
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
})

/** Raw upstream responses of a capture, byte for byte. */
export const sourceResponses = sqliteTable(
  'source_responses',
  {
    id: text().primaryKey(),
    captureId: text()
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    body: blob({ mode: 'buffer' }).$type<Buffer>().notNull(),
    contentType: text().notNull(),
    sourceUrl: text().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('source_responses_position').on(t.captureId, t.position)],
)

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
    captureOptions: text({ mode: 'json' }),
  },
  (t) => [
    index('submissions_records')
      .on(t.createdAt, t.id)
      .where(sql`${t.parentSubmission} IS NULL AND ${t.input} <> ''`),
    index('submissions_capture').on(t.captureId),
    // Partial: top-level requests (no parent) are most rows, and indexing
    // them leads SQLite to read records through this index instead.
    index('submissions_parent')
      .on(t.parentSubmission)
      .where(sql`${t.parentSubmission} IS NOT NULL`),
  ],
)

export const refreshBatches = sqliteTable('refresh_batches', {
  id: text().primaryKey(),
  collectionIds: text({ mode: 'json' }).$type<string[]>().notNull(),
  position: integer().notNull().default(0),
  reused: integer().notNull().default(0),
  rejected: integer().notNull().default(0),
  captureIds: text({ mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  state: text({ enum: ['running', 'complete', 'failed'] })
    .notNull()
    .default('running'),
  error: text().notNull().default(''),
  createdAt: createdAt(),
})

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

/** Browser sessions, by the SHA-256 of the cookie value. */
export const webSessions = sqliteTable(
  'web_sessions',
  {
    digest: text().primaryKey(),
    expiresAt: timestamp().notNull(),
  },
  (t) => [index('web_sessions_expires').on(t.expiresAt)],
)

/** REST API tokens, by the SHA-256 of the token. */
export const apiTokens = sqliteTable('api_tokens', {
  id: text().primaryKey(),
  digest: text().notNull().unique(),
  name: text().notNull(),
  createdAt: createdAt(),
})

/**
 * Messages the bot owes the owner: a capture's status and result, a shown
 * collection, a refresh batch. Progress is checkpointed per sent part, so a
 * restart resumes without resending.
 */
export const telegramDeliveries = sqliteTable(
  'telegram_deliveries',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['submission', 'show', 'batch'] }).notNull(),
    // Submission, collection or refresh batch id.
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
