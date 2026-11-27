/* eslint-disable @typescript-eslint/no-redeclare -- each message's helpers share its name, as in the generated code */
/**
 * Messages exchanged between the core and platform code, carried over from the
 * former gRPC adapter protocol (api/adapter/v1/adapter.proto on the golang
 * branch). Field names and meanings are unchanged.
 */
import { Buffer } from 'node:buffer'

export const Visibility = {
  VISIBILITY_UNSPECIFIED: 0,
  VISIBILITY_PUBLIC: 1,
  VISIBILITY_PRIVATE: 2,
} as const
export type Visibility = (typeof Visibility)[keyof typeof Visibility]

/** Names are extensible. Unknown names/major versions are ignored by callers. */
export interface Capability {
  name: string
  major: number
  minor: number
}

export interface Provider {
  id: string
  authentication: string
  visibilities: Visibility[]
  capabilities: Capability[]
  entityTypes: string[]
  /** Default within this authentication mode. */
  defaultProvider: boolean
  /** Adapter-owned input instructions. */
  credentialHelp: string
}

export interface DescribeResponse {
  /** Strict major.minor. Minor revisions must remain backward compatible. */
  protocolVersion: string
  adapterId: string
  version: string
  hosts: string[]
  providers: Provider[]
  entityTypes: EntityType[]
  /** Adapter-owned user-facing name; empty means use adapter_id. */
  displayName: string
}

export interface FetchRequest {
  url: string
  externalId: string
  providerId: string
  connectionId: string
  accessScope: string
  requestId: string
  credential: Credential | undefined
  platform: string
  kind: string
  objectScope: string
  /** Optional target size; adapter may exceed it to preserve whole upstream pages. */
  pageSize: number
  /** Opaque capture.page/1 continuation, same provider and connection. */
  pageCursor: string
  /** Related captures must not recursively expand collections. */
  automatic: boolean
  /** capture.prefetch/1: the prefetch of the related target that created this automatic capture. */
  prefetch: Buffer
  /** credential.deferred/1: credential withheld; fail with trailer credential-required to get it. */
  credentialDeferred: boolean
  /**
   * Optional RFC 3339 date cutoff of a collection page: the adapter may stop
   * reading upstream pages once its listing is past it (see `pastCutoff`),
   * still returning the real next cursor.
   */
  since: string
  /**
   * The stable id the app already knows for a target saved under another
   * name (a profile saved by its handle): from an earlier capture, or an
   * account a list or post showed under that handle. The adapter may look
   * the object up by it; the answer is still for `externalId`. Empty when
   * none is known.
   */
  stableId: string
}

export interface Resource {
  url: string
  kind: string
  /** Immutable media identity including rendition, scoped by platform/provider/access. */
  immutableKey: string
  altText: string
  sensitive: boolean
  /** Adapter-defined role. Empty resources appear in the generic presentation. */
  purpose: string
  /** Pixel size of the media as the platform describes it; absent or 0 when unknown. */
  width?: number
  height?: number
  /**
   * A smaller rendition of the platform's to show in lists: a smaller size of
   * an image, a video's poster. Absent when there is none, in which case an
   * image stands for itself and a video has no still.
   */
  thumbnailUrl?: string
}

/** Adapter-owned JSON Schema (2020-12), bundled and self-contained. */
export interface EntityType {
  name: string
  jsonSchema: Buffer
  /**
   * JSON pointers into the entity's data at observed values (counts) rather
   * than content: kept with each capture and left out of versions.
   */
  metricPaths: string[]
  /**
   * JSON pointers into the entity's data at values the platform reports one
   * way on one request and another on the next, and the app never shows:
   * kept as received, but a change there alone is not a new revision.
   */
  volatilePaths: string[]
}

export interface Entity {
  /** Local graph key, not a database ID. */
  key: string
  type: string
  externalId: string
  dataJson: Buffer
  /** Indices in FetchResponse.resources. */
  resourceIndices: number[]
  /**
   * Non-root context: snapshot and entity-version it, but exclude its data/media
   * and generic author_name/summary from collection revision comparison.
   */
  contextOnly: boolean
}

export interface EntityRelation {
  source: string
  target: string
  type: string
}

export interface EntityGraph {
  root: string
  entities: Entity[]
  relations: EntityRelation[]
}

export interface SourceResponse {
  /** Original response body, before JSON parsing or normalization. */
  body: Buffer
  contentType: string
  /** No credentials or request headers. */
  sourceUrl: string
  /** Account responses stay private even for public posts. */
  visibility: Visibility
}

export interface RelatedTarget {
  /** Optional listing metadata for the capture filters of collections. */
  publishedAt: string
  /** image or video, excluding quoted media. */
  mediaTypes: string[]
  /** post, quote or repost; empty for non-post references. */
  postType: string
  url: string
  /** Zero reuses any existing collection; positive refreshes stale data. */
  refreshAfterSeconds: number
  /** Latest known content change (publication or edit) in RFC 3339; empty when unknown. */
  updatedAt: string
  /** capture.prefetch/1: adapter-owned observation of the target, at most 64 KiB, handed back once in FetchRequest.prefetch. */
  prefetch: Buffer
  /**
   * When the entry appeared on the listing in RFC 3339 (a repost: when it was
   * reposted, not the original's publication); empty when unknown.
   */
  listedAt: string
  /** Pinned to the top of the listing, out of date order (or possibly so). */
  pinned: boolean
}

export interface FetchResponse {
  externalId: string
  /** Optional generic presentation; channels do not parse entity JSON. */
  text: string
  textKind: string
  resources: Resource[]
  warnings: string[]
  providerId: string
  adapterVersion: string
  textSource: string
  incomplete: boolean
  visibility: Visibility
  graph: EntityGraph | undefined
  sourceResponses: SourceResponse[]
  /** Adapter-provided list presentation; channels may truncate it. */
  summary: string
  /** Generic presentation, supplied by the adapter. */
  authorName: string
  /** Optional stable identity, same platform and kind. */
  canonicalTarget: ResolveResponse | undefined
  /** capture.related/1; one level, same provider/connection. */
  relatedTargets: RelatedTarget[]
  /** Optional collection batch limit; zero disables batch actions. */
  maxBatchSize: number
  /** Empty at end of collection; capture.page/1. */
  nextPageCursor: string
  /** Original publication time in RFC 3339; empty when unknown. */
  publishedAt: string
  /** Embedded (non-root) objects in the graph lacking public evidence. */
  restrictedTargets: ObjectRef[]
  /**
   * A private result that is private only because this account (same platform)
   * limits who may read it. Once the account is observed public, the stored
   * versions become public.
   */
  privateSubject: ObjectRef | undefined
  /** Accounts (same platform) this fetch observed as public. */
  publicSubjects: ObjectRef[]
}

/** Execution-only secrets; never persisted in task payloads or logs. */
export interface Credential {
  data: Buffer
}

export interface ResolveResponse {
  url: string
  platform: string
  kind: string
  objectScope: string
  externalId: string
  /** Explicit capture expands a collection of related targets. */
  collection: boolean
  /** Explicit submissions always observe this target again. */
  refreshOnSubmit: boolean
}

export interface CheckConnectionResponse {
  accountId: string
  username: string
}

export interface ObjectRef {
  platform: string
  kind: string
  objectScope: string
  externalId: string
}

type Builtin =
  Date | Function | Uint8Array | string | number | boolean | undefined

type DeepPartial<T> = T extends Builtin
  ? T
  : T extends globalThis.Array<infer U>
    ? globalThis.Array<DeepPartial<U>>
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<DeepPartial<U>>
      : T extends {}
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : Partial<T>

function createBaseCapability(): Capability {
  return { name: '', major: 0, minor: 0 }
}

export const Capability = {
  fromPartial(object: DeepPartial<Capability>): Capability {
    const message = createBaseCapability()
    message.name = object.name ?? ''
    message.major = object.major ?? 0
    message.minor = object.minor ?? 0
    return message
  },
}

function createBaseProvider(): Provider {
  return {
    id: '',
    authentication: '',
    visibilities: [],
    capabilities: [],
    entityTypes: [],
    defaultProvider: false,
    credentialHelp: '',
  }
}

export const Provider = {
  fromPartial(object: DeepPartial<Provider>): Provider {
    const message = createBaseProvider()
    message.id = object.id ?? ''
    message.authentication = object.authentication ?? ''
    message.visibilities = object.visibilities?.map((e) => e) || []
    message.capabilities =
      object.capabilities?.map((e) => Capability.fromPartial(e)) || []
    message.entityTypes = object.entityTypes?.map((e) => e) || []
    message.defaultProvider = object.defaultProvider ?? false
    message.credentialHelp = object.credentialHelp ?? ''
    return message
  },
}

function createBaseDescribeResponse(): DescribeResponse {
  return {
    protocolVersion: '',
    adapterId: '',
    version: '',
    hosts: [],
    providers: [],
    entityTypes: [],
    displayName: '',
  }
}

export const DescribeResponse = {
  fromPartial(object: DeepPartial<DescribeResponse>): DescribeResponse {
    const message = createBaseDescribeResponse()
    message.protocolVersion = object.protocolVersion ?? ''
    message.adapterId = object.adapterId ?? ''
    message.version = object.version ?? ''
    message.hosts = object.hosts?.map((e) => e) || []
    message.providers =
      object.providers?.map((e) => Provider.fromPartial(e)) || []
    message.entityTypes =
      object.entityTypes?.map((e) => EntityType.fromPartial(e)) || []
    message.displayName = object.displayName ?? ''
    return message
  },
}

function createBaseFetchRequest(): FetchRequest {
  return {
    url: '',
    externalId: '',
    providerId: '',
    connectionId: '',
    accessScope: '',
    requestId: '',
    credential: undefined,
    platform: '',
    kind: '',
    objectScope: '',
    pageSize: 0,
    pageCursor: '',
    automatic: false,
    prefetch: Buffer.alloc(0),
    credentialDeferred: false,
    since: '',
    stableId: '',
  }
}

export const FetchRequest = {
  fromPartial(object: DeepPartial<FetchRequest>): FetchRequest {
    const message = createBaseFetchRequest()
    message.url = object.url ?? ''
    message.externalId = object.externalId ?? ''
    message.providerId = object.providerId ?? ''
    message.connectionId = object.connectionId ?? ''
    message.accessScope = object.accessScope ?? ''
    message.requestId = object.requestId ?? ''
    message.credential =
      object.credential !== undefined && object.credential !== null
        ? Credential.fromPartial(object.credential)
        : undefined
    message.platform = object.platform ?? ''
    message.kind = object.kind ?? ''
    message.objectScope = object.objectScope ?? ''
    message.pageSize = object.pageSize ?? 0
    message.pageCursor = object.pageCursor ?? ''
    message.automatic = object.automatic ?? false
    message.prefetch = object.prefetch ?? Buffer.alloc(0)
    message.credentialDeferred = object.credentialDeferred ?? false
    message.since = object.since ?? ''
    message.stableId = object.stableId ?? ''
    return message
  },
}

function createBaseResource(): Resource {
  return {
    url: '',
    kind: '',
    immutableKey: '',
    altText: '',
    sensitive: false,
    purpose: '',
  }
}

export const Resource = {
  fromPartial(object: DeepPartial<Resource>): Resource {
    const message = createBaseResource()
    message.url = object.url ?? ''
    message.kind = object.kind ?? ''
    message.immutableKey = object.immutableKey ?? ''
    message.altText = object.altText ?? ''
    message.sensitive = object.sensitive ?? false
    message.purpose = object.purpose ?? ''
    if (object.width) message.width = object.width
    if (object.height) message.height = object.height
    if (object.thumbnailUrl) message.thumbnailUrl = object.thumbnailUrl
    return message
  },
}

function createBaseEntityType(): EntityType {
  return {
    name: '',
    jsonSchema: Buffer.alloc(0),
    metricPaths: [],
    volatilePaths: [],
  }
}

export const EntityType = {
  fromPartial(object: DeepPartial<EntityType>): EntityType {
    const message = createBaseEntityType()
    message.name = object.name ?? ''
    message.jsonSchema = object.jsonSchema ?? Buffer.alloc(0)
    message.metricPaths = object.metricPaths?.map((e) => e) || []
    message.volatilePaths = object.volatilePaths?.map((e) => e) || []
    return message
  },
}

function createBaseEntity(): Entity {
  return {
    key: '',
    type: '',
    externalId: '',
    dataJson: Buffer.alloc(0),
    resourceIndices: [],
    contextOnly: false,
  }
}

export const Entity = {
  fromPartial(object: DeepPartial<Entity>): Entity {
    const message = createBaseEntity()
    message.key = object.key ?? ''
    message.type = object.type ?? ''
    message.externalId = object.externalId ?? ''
    message.dataJson = object.dataJson ?? Buffer.alloc(0)
    message.resourceIndices = object.resourceIndices?.map((e) => e) || []
    message.contextOnly = object.contextOnly ?? false
    return message
  },
}

function createBaseEntityRelation(): EntityRelation {
  return { source: '', target: '', type: '' }
}

export const EntityRelation = {
  fromPartial(object: DeepPartial<EntityRelation>): EntityRelation {
    const message = createBaseEntityRelation()
    message.source = object.source ?? ''
    message.target = object.target ?? ''
    message.type = object.type ?? ''
    return message
  },
}

function createBaseEntityGraph(): EntityGraph {
  return { root: '', entities: [], relations: [] }
}

export const EntityGraph = {
  fromPartial(object: DeepPartial<EntityGraph>): EntityGraph {
    const message = createBaseEntityGraph()
    message.root = object.root ?? ''
    message.entities = object.entities?.map((e) => Entity.fromPartial(e)) || []
    message.relations =
      object.relations?.map((e) => EntityRelation.fromPartial(e)) || []
    return message
  },
}

function createBaseSourceResponse(): SourceResponse {
  return {
    body: Buffer.alloc(0),
    contentType: '',
    sourceUrl: '',
    visibility: 0,
  }
}

export const SourceResponse = {
  fromPartial(object: DeepPartial<SourceResponse>): SourceResponse {
    const message = createBaseSourceResponse()
    message.body = object.body ?? Buffer.alloc(0)
    message.contentType = object.contentType ?? ''
    message.sourceUrl = object.sourceUrl ?? ''
    message.visibility = object.visibility ?? 0
    return message
  },
}

function createBaseRelatedTarget(): RelatedTarget {
  return {
    publishedAt: '',
    mediaTypes: [],
    postType: '',
    url: '',
    refreshAfterSeconds: 0,
    updatedAt: '',
    prefetch: Buffer.alloc(0),
    listedAt: '',
    pinned: false,
  }
}

export const RelatedTarget = {
  fromPartial(object: DeepPartial<RelatedTarget>): RelatedTarget {
    const message = createBaseRelatedTarget()
    message.publishedAt = object.publishedAt ?? ''
    message.mediaTypes = object.mediaTypes?.map((e) => e) || []
    message.postType = object.postType ?? ''
    message.url = object.url ?? ''
    message.refreshAfterSeconds = object.refreshAfterSeconds ?? 0
    message.updatedAt = object.updatedAt ?? ''
    message.prefetch = object.prefetch ?? Buffer.alloc(0)
    message.listedAt = object.listedAt ?? ''
    message.pinned = object.pinned ?? false
    return message
  },
}

function createBaseFetchResponse(): FetchResponse {
  return {
    externalId: '',
    text: '',
    textKind: '',
    resources: [],
    warnings: [],
    providerId: '',
    adapterVersion: '',
    textSource: '',
    incomplete: false,
    visibility: 0,
    graph: undefined,
    sourceResponses: [],
    summary: '',
    authorName: '',
    canonicalTarget: undefined,
    relatedTargets: [],
    maxBatchSize: 0,
    nextPageCursor: '',
    publishedAt: '',
    restrictedTargets: [],
    privateSubject: undefined,
    publicSubjects: [],
  }
}

export const FetchResponse = {
  fromPartial(object: DeepPartial<FetchResponse>): FetchResponse {
    const message = createBaseFetchResponse()
    message.externalId = object.externalId ?? ''
    message.text = object.text ?? ''
    message.textKind = object.textKind ?? ''
    message.resources =
      object.resources?.map((e) => Resource.fromPartial(e)) || []
    message.warnings = object.warnings?.map((e) => e) || []
    message.providerId = object.providerId ?? ''
    message.adapterVersion = object.adapterVersion ?? ''
    message.textSource = object.textSource ?? ''
    message.incomplete = object.incomplete ?? false
    message.visibility = object.visibility ?? 0
    message.graph =
      object.graph !== undefined && object.graph !== null
        ? EntityGraph.fromPartial(object.graph)
        : undefined
    message.sourceResponses =
      object.sourceResponses?.map((e) => SourceResponse.fromPartial(e)) || []
    message.summary = object.summary ?? ''
    message.authorName = object.authorName ?? ''
    message.canonicalTarget =
      object.canonicalTarget !== undefined && object.canonicalTarget !== null
        ? ResolveResponse.fromPartial(object.canonicalTarget)
        : undefined
    message.relatedTargets =
      object.relatedTargets?.map((e) => RelatedTarget.fromPartial(e)) || []
    message.maxBatchSize = object.maxBatchSize ?? 0
    message.nextPageCursor = object.nextPageCursor ?? ''
    message.publishedAt = object.publishedAt ?? ''
    message.restrictedTargets =
      object.restrictedTargets?.map((e) => ObjectRef.fromPartial(e)) || []
    message.privateSubject =
      object.privateSubject !== undefined && object.privateSubject !== null
        ? ObjectRef.fromPartial(object.privateSubject)
        : undefined
    message.publicSubjects =
      object.publicSubjects?.map((e) => ObjectRef.fromPartial(e)) || []
    return message
  },
}

function createBaseCredential(): Credential {
  return { data: Buffer.alloc(0) }
}

export const Credential = {
  fromPartial(object: DeepPartial<Credential>): Credential {
    const message = createBaseCredential()
    message.data = object.data ?? Buffer.alloc(0)
    return message
  },
}

function createBaseResolveResponse(): ResolveResponse {
  return {
    url: '',
    platform: '',
    kind: '',
    objectScope: '',
    externalId: '',
    collection: false,
    refreshOnSubmit: false,
  }
}

export const ResolveResponse = {
  fromPartial(object: DeepPartial<ResolveResponse>): ResolveResponse {
    const message = createBaseResolveResponse()
    message.url = object.url ?? ''
    message.platform = object.platform ?? ''
    message.kind = object.kind ?? ''
    message.objectScope = object.objectScope ?? ''
    message.externalId = object.externalId ?? ''
    message.collection = object.collection ?? false
    message.refreshOnSubmit = object.refreshOnSubmit ?? false
    return message
  },
}

function createBaseCheckConnectionResponse(): CheckConnectionResponse {
  return { accountId: '', username: '' }
}

export const CheckConnectionResponse = {
  fromPartial(
    object: DeepPartial<CheckConnectionResponse>,
  ): CheckConnectionResponse {
    const message = createBaseCheckConnectionResponse()
    message.accountId = object.accountId ?? ''
    message.username = object.username ?? ''
    return message
  },
}

function createBaseObjectRef(): ObjectRef {
  return { platform: '', kind: '', objectScope: '', externalId: '' }
}

export const ObjectRef = {
  fromPartial(object: DeepPartial<ObjectRef>): ObjectRef {
    const message = createBaseObjectRef()
    message.platform = object.platform ?? ''
    message.kind = object.kind ?? ''
    message.objectScope = object.objectScope ?? ''
    message.externalId = object.externalId ?? ''
    return message
  },
}
