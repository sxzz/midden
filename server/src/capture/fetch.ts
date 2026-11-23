import { Buffer } from 'node:buffer'
import { and, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
  captures,
  collections,
  connections,
  sourceResponses,
} from '#db/schema.ts'
import { AppError } from '#errors.ts'
import {
  PermanentError,
  RetryError,
  SnoozeError,
  type Job,
} from '#jobs/queue.ts'
import { isProviderFailure } from '#platforms/platform.ts'
import {
  FetchRequest,
  type Credential,
  type FetchResponse,
  type Provider,
  type Resource,
} from '#platforms/protocol.ts'
import { provider as findProvider, supports } from '#platforms/registry.ts'
import { status } from '#platforms/rpc.ts'
import {
  MAX_MEDIA,
  MAX_PURPOSED_MEDIA,
  type CaptureContext,
} from './context.ts'
import { credentialRequired, retryAfter, sourceState } from './errors.ts'
import { validateGraph } from './graph.ts'
import { canonicalJson, sha256Hex } from './json.ts'
import { finalizeSettled, loadCapture, validateExecution } from './lifecycle.ts'
import { resolveCaptureScope } from './scope.ts'
import type { Payload } from './payload.ts'

const FETCH_DEADLINE = 45_000
const MAX_TEXT = 1 << 20
const MAX_SOURCE_BYTES = 4 << 20
const MAX_RELATED = 512
const MAX_PREFETCH = 64 << 10
const MAX_CURSOR = 4096
const MAX_SOURCE_URL = 8192

// Captures using one account run one at a time, to stay gentle with it.
const busyConnections = new Set<string>()

/** Fetch a queued capture and stage its result for download and finalize. */
export async function runCapture(ctx: CaptureContext, job: Job): Promise<void> {
  const { db } = ctx
  const capture = db.transaction((tx) => loadCapture(tx, job.ref))
  if (capture?.state !== 'queued') return
  const collection = db
    .select()
    .from(collections)
    .where(eq(collections.id, capture.collectionId))
    .get()!
  const platform = ctx.platforms.byId(capture.adapterId)
  const policy = findProvider(platform, capture.providerId)

  let credential: Credential | undefined
  let revision: number | null = null
  if (capture.connectionId) {
    const connection = db
      .select()
      .from(connections)
      .where(eq(connections.id, capture.connectionId))
      .get()
    if (
      connection?.state !== 'ready' ||
      !connection.credentialRef ||
      connection.providerId !== capture.providerId
    )
      throw new AppError('connection')
    revision = connection.revision
    credential = {
      data: Buffer.from(ctx.openCredential(connection.credentialRef)),
    }
  }
  if (!supports(policy, 'capture.fetch')) throw new AppError('unsupported')
  if (Boolean(capture.connectionId) === (policy.authentication === 'none'))
    throw new AppError('unsupported')

  const deferred =
    !!capture.connectionId && supports(policy, 'credential.deferred')
  let holding = false
  const take = () => {
    if (!capture.connectionId || holding) return
    if (busyConnections.has(capture.connectionId)) throw new SnoozeError(1000)
    busyConnections.add(capture.connectionId)
    holding = true
  }
  try {
    if (!deferred) take()
    const signal = AbortSignal.any([
      job.signal,
      AbortSignal.timeout(FETCH_DEADLINE),
    ])
    const request = FetchRequest.fromPartial({
      url: collection.url,
      externalId: collection.externalId,
      platform: collection.platform,
      kind: collection.kind,
      objectScope: collection.objectScope,
      providerId: capture.providerId,
      connectionId: capture.connectionId ?? '',
      accessScope: capture.scope,
      requestId: capture.id,
      pageSize: capture.pageSize,
      pageCursor: capture.pageCursor,
      automatic: capture.automatic,
      prefetch: capture.prefetch ?? Buffer.alloc(0),
    })
    let response: FetchResponse
    try {
      if (deferred) {
        // The account is lent only once the platform says it needs it.
        try {
          response = await platform.fetch(
            { ...request, credentialDeferred: true },
            signal,
          )
        } catch (error) {
          if (!credentialRequired(error)) throw error
          take()
          response = await platform.fetch({ ...request, credential }, signal)
        }
      } else {
        response = await platform.fetch({ ...request, credential }, signal)
      }
    } catch (error) {
      throw onFetchError(ctx, capture, revision, error)
    }
    const staged = stage(response, policy, platform.description.entityTypes, {
      externalId: collection.externalId,
      providerId: capture.providerId,
      platform: collection.platform,
      kind: collection.kind,
      objectScope: collection.objectScope,
    })
    commit(ctx, capture.id, revision, response, staged)
  } finally {
    if (holding) busyConnections.delete(capture.connectionId!)
  }
}

/** Record what a fetch error says about the account and the source. */
function onFetchError(
  ctx: CaptureContext,
  capture: { connectionId: string | null; collectionId: string },
  revision: number | null,
  error: unknown,
): unknown {
  const { db } = ctx
  if (
    capture.connectionId &&
    isProviderFailure(error) &&
    error.code === status.UNAUTHENTICATED
  )
    db.update(connections)
      .set({ state: 'reauth_required' })
      .where(
        and(
          eq(connections.id, capture.connectionId),
          eq(connections.revision, revision ?? -1),
          eq(connections.state, 'ready'),
        ),
      )
      .run()
  const gone = sourceState(error)
  if (gone)
    db.update(collections)
      .set({
        sourceState: gone,
        sourceStateAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .where(eq(collections.id, capture.collectionId))
      .run()
  const seconds = retryAfter(error)
  if (seconds)
    return new RetryError('来源平台暂时出错', seconds * 1000, {
      cause: error,
    })
  return error
}

interface Identity {
  externalId: string
  providerId: string
  platform: string
  kind: string
  objectScope: string
}

interface Staged {
  payload: Payload
  resources: Resource[]
  sources: FetchResponse['sourceResponses']
}

function validURL(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !!url.hostname &&
    !url.username &&
    !url.password
  )
}

/** Validate a fetch result and turn it into the payload to stage. */
export function stage(
  response: FetchResponse,
  policy: Provider,
  entityTypes: Parameters<typeof validateGraph>[2],
  identity: Identity,
): Staged {
  if (
    response.externalId !== identity.externalId ||
    response.providerId !== identity.providerId
  )
    throw new PermanentError('平台返回的内容与链接不符')
  validateRelated(response, policy, identity)
  if (Buffer.byteLength(response.text) > MAX_TEXT)
    throw new PermanentError('正文超出长度上限')
  const graph = validateGraph(response, policy, entityTypes)
  const sources = keepSources(response.sourceResponses)

  const payload: Payload = {
    ...(response.authorName ? { author_name: response.authorName } : {}),
    ...(response.publishedAt ? { published_at: response.publishedAt } : {}),
    ...(response.summary ? { summary: response.summary } : {}),
    ...(graph ? { graph: graph.graph } : {}),
    text: response.text,
    text_kind: response.textKind,
    warnings: [...response.warnings],
    adapter_version: response.adapterVersion,
    ...(response.textSource ? { text_source: response.textSource } : {}),
    ...(response.incomplete ? { incomplete: true } : {}),
    ...(graph && Object.keys(graph.metrics).length
      ? { metrics: graph.metrics }
      : {}),
    ...(graph && Object.keys(graph.metricPaths).length
      ? { metric_paths: graph.metricPaths }
      : {}),
  }

  // Apply the media limits, keeping graph references to what stays.
  const kept: Resource[] = []
  const positions = new Map<number, number>()
  let media = 0
  let purposed = 0
  for (const [index, resource] of response.resources.entries()) {
    if (
      Buffer.byteLength(resource.altText) > MAX_TEXT ||
      Buffer.byteLength(resource.purpose) > 128
    )
      throw new PermanentError('媒体信息超出上限')
    let keep = resource.kind === 'image' || resource.kind === 'video'
    if (resource.purpose) keep &&= ++purposed <= MAX_PURPOSED_MEDIA
    else keep &&= ++media <= MAX_MEDIA
    if (!keep) {
      payload.incomplete = true
      payload.warnings.push('部分资源类型不支持或资源数量超过限制')
      continue
    }
    positions.set(index, kept.length)
    kept.push(resource)
    ;(payload.media_descriptions ??= []).push(resource.altText)
    ;(payload.media_sensitive ??= []).push(resource.sensitive)
  }
  for (const entity of payload.graph?.entities ?? []) {
    if (!entity.resource_indices) continue
    const indices = entity.resource_indices
      .map((index) => positions.get(index))
      .filter((index) => index !== undefined)
    if (indices.length) entity.resource_indices = indices
    else delete entity.resource_indices
  }
  return { payload, resources: kept, sources }
}

function validateRelated(
  response: FetchResponse,
  policy: Provider,
  identity: Identity,
): void {
  if (
    response.nextPageCursor.length > MAX_CURSOR ||
    response.maxBatchSize > 1000 ||
    ((response.nextPageCursor || response.maxBatchSize > 0) &&
      !supports(policy, 'capture.page'))
  )
    throw new PermanentError('平台返回的翻页信息无效')
  const canonical = response.canonicalTarget
  if (
    canonical &&
    (!supports(policy, 'capture.canonical') ||
      canonical.platform !== identity.platform ||
      canonical.kind !== identity.kind ||
      canonical.objectScope !== identity.objectScope ||
      !canonical.externalId ||
      !validURL(canonical.url))
  )
    throw new PermanentError('平台返回的规范链接无效')
  if (response.relatedTargets.length && !supports(policy, 'capture.related'))
    throw new PermanentError('平台返回了未声明的关联内容')
  if (response.relatedTargets.length > MAX_RELATED)
    throw new PermanentError('单页关联内容超过 512 条')
  for (const target of response.relatedTargets) {
    if (!validURL(target.url))
      throw new PermanentError('平台返回的关联内容无效')
    if (
      target.prefetch.length &&
      (target.prefetch.length > MAX_PREFETCH ||
        !supports(policy, 'capture.prefetch'))
    )
      throw new PermanentError('平台返回的预取内容无效或过大')
  }
}

/** Raw responses in order, up to 4 MiB in total; each must be JSON. */
function keepSources(
  sources: FetchResponse['sourceResponses'],
): FetchResponse['sourceResponses'] {
  const kept: FetchResponse['sourceResponses'] = []
  let total = 0
  for (const source of sources) {
    total += source.body.length
    if (total > MAX_SOURCE_BYTES) break
    kept.push(source)
  }
  for (const source of kept) {
    let valid = source.body.length > 0 && !!source.contentType
    valid &&= source.sourceUrl.length <= MAX_SOURCE_URL
    if (valid) {
      try {
        JSON.parse(Buffer.from(source.body).toString('utf8'))
      } catch {
        valid = false
      }
    }
    if (!valid) throw new PermanentError('平台原始响应无效')
  }
  return kept
}

/** Store the staged result and start downloading its media. */
function commit(
  ctx: CaptureContext,
  captureId: string,
  revision: number | null,
  response: FetchResponse,
  staged: Staged,
): void {
  ctx.db.transaction((tx) => {
    let capture = loadCapture(tx, captureId)
    if (capture?.state !== 'queued') return
    validateExecution(tx, capture, revision)
    if (response.canonicalTarget) {
      resolveCaptureScope(ctx, tx, captureId, response.canonicalTarget)
      capture = loadCapture(tx, captureId)
      // Joined an identical capture already running; it stores the result.
      if (capture?.state !== 'queued') return
    }
    const collection = tx
      .select({ platform: collections.platform })
      .from(collections)
      .where(eq(collections.id, capture.collectionId))
      .get()!
    tx.update(captures)
      .set({
        prefetch: null,
        credentialRevision: revision,
        relatedTargets: response.relatedTargets.map((target) => ({
          url: target.url,
          refreshAfterSeconds: target.refreshAfterSeconds,
          updatedAt: target.updatedAt,
          publishedAt: target.publishedAt,
          mediaTypes: target.mediaTypes,
          postType: target.postType,
          ...(target.prefetch.length
            ? { prefetch: Buffer.from(target.prefetch).toString('base64') }
            : {}),
        })),
        nextPageCursor: response.nextPageCursor,
        maxBatchSize: response.maxBatchSize,
        state: 'downloading',
        payload: staged.payload,
        adapterVersion: response.adapterVersion,
      })
      .where(eq(captures.id, captureId))
      .run()
    for (const [position, source] of staged.sources.entries()) {
      const body = Buffer.from(source.body)
      tx.insert(sourceResponses)
        .values({
          id: newId(),
          captureId,
          position,
          body,
          contentType: source.contentType,
          sourceUrl: source.sourceUrl,
          sha256: sha256Hex(body),
          size: body.length,
        })
        .onConflictDoNothing()
        .run()
    }
    for (const [position, resource] of staged.resources.entries()) {
      const assetId = newId()
      tx.insert(assets)
        .values({
          id: assetId,
          captureId,
          position,
          sourceUrl: resource.url,
          kind: resource.kind as 'image' | 'video',
          cacheKey: resource.immutableKey
            ? sha256Hex(
                canonicalJson([collection.platform, resource.immutableKey]),
              )
            : '',
          altText: resource.altText,
          sensitive: resource.sensitive,
          purpose: resource.purpose,
        })
        .run()
      ctx.queue.enqueue(tx, 'download', assetId)
    }
    finalizeSettled(ctx, tx, captureId)
  })
}
