import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  FetchResponse,
  RelatedTarget,
  SourceResponse,
  Visibility,
  type FetchRequest,
} from '../protocol.ts'
import { status } from '../rpc.ts'
import { InstagramClient, mediaId, type Node } from './client.ts'
import {
  attachMentions,
  postResult,
  profileResult,
  timestamp,
} from './entities.ts'
import { credentialRequired, ProviderError } from './errors.ts'
import { shortcodeFromPk } from './resolve.ts'
import type { SessionCredential } from './credential.ts'

interface Cursor {
  user: string
  mode: 'session'
  cursor: string
}
function continuation(raw: string, id: string): Cursor | undefined {
  if (!raw) return
  try {
    const value = JSON.parse(raw)
    if (
      raw.length > 4096 ||
      value.user !== id ||
      value.mode !== 'session' ||
      typeof value.cursor !== 'string' ||
      !value.cursor ||
      value.cursor.length > 3000
    )
      throw new Error()
    return value
  } catch {
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      'Instagram 列表已变化，请从主页链接重新开始',
    )
  }
}
export class CaptureStrategy {
  private listed = new Map<
    string,
    { at: number; bytes: number; result: FetchResponse }
  >()
  private listedBytes = 0
  private fetcher: typeof fetch
  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher
  }

  private listedKey(
    req: FetchRequest,
    credential: SessionCredential,
    id: string,
  ) {
    return `${req.connectionId}:${createHash('sha256').update(JSON.stringify(credential)).digest('hex')}:${id}`
  }

  private remember(
    req: FetchRequest,
    credential: SessionCredential,
    user: Node,
    item: Node,
    client: InstagramClient,
  ) {
    const id = mediaId(item)
    const author = item.user ?? item.owner
    const node =
      String(author?.pk ?? author?.id) === String(user.pk ?? user.id)
        ? { ...item, user: { ...author, ...user } }
        : item
    const result = postResult(node, id, Visibility.VISIBILITY_PRIVATE)
    result.providerId = req.providerId
    result.textSource = 'instagram-session'
    result.sourceResponses = [client.sources[0], client.sources.at(-1)]
      .filter(
        (source, index, entries): source is SourceResponse =>
          !!source && entries.indexOf(source) === index,
      )
      .map((source) => SourceResponse.fromPartial(source))
    const key = this.listedKey(req, credential, id)
    const bytes =
      result.sourceResponses.reduce(
        (sum, source) => sum + source.body.length,
        0,
      ) +
      Buffer.byteLength(JSON.stringify(result.graph)) +
      Buffer.byteLength(JSON.stringify(result.resources))
    const old = this.listed.get(key)
    if (old) {
      this.listedBytes -= old.bytes
      this.listed.delete(key)
    }
    this.listed.set(key, { at: Date.now(), bytes, result })
    this.listedBytes += bytes
    while (this.listed.size > 500 || this.listedBytes > 64 << 20) {
      const first = this.listed.keys().next().value!
      this.listedBytes -= this.listed.get(first)!.bytes
      this.listed.delete(first)
    }
  }

  async fetch(
    req: FetchRequest,
    signal: AbortSignal,
    credential?: SessionCredential,
  ): Promise<FetchResponse> {
    if (req.pageCursor && (req.kind !== 'profile' || req.automatic))
      throw new ProviderError(status.INVALID_ARGUMENT, '翻页信息无效')
    if (!credential) {
      if (req.credentialDeferred) credentialRequired()
      throw new ProviderError(
        status.FAILED_PRECONDITION,
        'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
      )
    }
    if (signal.aborted)
      throw new ProviderError(status.DEADLINE_EXCEEDED, 'Instagram 请求被中断')
    if (req.automatic && req.kind === 'post') {
      const listed = this.listed.get(
        this.listedKey(req, credential, req.externalId),
      )
      if (listed && Date.now() - listed.at < 30 * 60_000)
        return FetchResponse.fromPartial(listed.result)
    }
    const client = new InstagramClient(signal, credential, this.fetcher)
    let result: FetchResponse
    if (req.kind === 'post') {
      const node = await client.post(req.externalId)
      result = postResult(node, req.externalId, Visibility.VISIBILITY_PRIVATE)
      const author = node.user ?? node.owner
      if (author?.pk || author?.id) {
        try {
          const user = await client.profile(String(author.pk ?? author.id))
          const profile = profileResult(
            user,
            String(user.pk ?? user.id),
            Visibility.VISIBILITY_PRIVATE,
          )
          const entity = result.graph!.entities.find(
            (entity) => entity.key === 'author',
          )
          if (entity) {
            const offset = result.resources.length
            entity.dataJson = profile.graph!.entities[0]!.dataJson
            entity.resourceIndices =
              profile.graph!.entities[0]!.resourceIndices.map((i) => i + offset)
            result.resources.push(...profile.resources)
          }
        } catch {
          if (signal.aborted)
            throw new ProviderError(
              status.DEADLINE_EXCEEDED,
              'Instagram 请求被中断',
            )
          // Keep the post's captured author when separate account metadata is unavailable.
        }
      }
    } else {
      const user = await client.profile(req.externalId)
      result = profileResult(
        user,
        req.externalId,
        Visibility.VISIBILITY_PRIVATE,
      )
      const cursor = continuation(
        req.pageCursor,
        result.canonicalTarget!.externalId,
      )
      result.maxBatchSize = 1000
      if (!req.automatic)
        await this.timeline(
          result,
          user,
          client,
          cursor?.cursor ?? '',
          req.pageSize || 100,
          req,
          credential,
        )
    }
    if (!req.automatic) attachMentions(result, result.text)
    result.providerId = req.providerId
    result.textSource = 'instagram-session'
    result.sourceResponses = client.sources.map((source) =>
      SourceResponse.fromPartial(source),
    )
    let bytes = 0
    result.sourceResponses = result.sourceResponses.filter((source, index) => {
      bytes += source.body.length
      if (index < 16 && bytes <= 4 << 20) return true
      result.incomplete = true
      if (!result.warnings.includes('部分 Instagram 原始响应超出保存限制。'))
        result.warnings.push('部分 Instagram 原始响应超出保存限制。')
      return false
    })
    return result
  }

  private async timeline(
    result: FetchResponse,
    user: Node,
    client: InstagramClient,
    cursor: string,
    size: number,
    req: FetchRequest,
    credential: SessionCredential,
  ): Promise<void> {
    const id = result.canonicalTarget!.externalId
    const target = Math.min(size, 100)
    const seen = new Set<string>()
    const members = new Map<string, Node>()
    let next = cursor
    for (let pages = 0; pages < 12; pages++) {
      if (seen.has(next)) {
        next = ''
        break
      }
      seen.add(next)
      try {
        const page = await client.page(user, next, target)
        if (
          page.items.length > 200 ||
          page.items.some((item) => !item || !/^\d+$/.test(mediaId(item)))
        )
          throw new ProviderError(
            status.UNAVAILABLE,
            'Instagram 时间线数据无效',
          )
        for (const item of page.items) {
          const postId = mediaId(item)
          members.set(postId, item)
          this.remember(req, credential, user, item, client)
          if (members.size > 200)
            throw new ProviderError(
              status.RESOURCE_EXHAUSTED,
              'Instagram 时间线超出单次翻页上限',
            )
          const url = `https://www.instagram.com/p/${shortcodeFromPk(postId)}/`
          if (result.relatedTargets.every((target) => target.url !== url))
            result.relatedTargets.push(
              RelatedTarget.fromPartial({
                url,
                publishedAt: timestamp(
                  item.taken_at ?? item.taken_at_timestamp,
                ),
                mediaTypes: [
                  ...new Set<string>(
                    (item.carousel_media || [item]).map((media: any) =>
                      media.media_type === 2 || media.video_versions?.length
                        ? 'video'
                        : 'image',
                    ),
                  ),
                ],
                postType: 'post',
                updatedAt:
                  timestamp(item.caption?.edited_at ?? item.edited_at) ||
                  timestamp(item.taken_at ?? item.taken_at_timestamp),
              }),
            )
        }
        next = page.next
        if (!next || members.size >= target) break
        if (pages === 11) {
          result.incomplete = true
          result.warnings.push('已达单次 Instagram 翻页上限。')
        }
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.metadata.get('credential-required').length
        )
          throw error
        if (
          client.signal.aborted ||
          (error instanceof ProviderError &&
            error.code === status.INVALID_ARGUMENT)
        )
          throw error
        result.incomplete = true
        result.warnings.push(
          error instanceof ProviderError
            ? error.message
            : 'Instagram 时间线读取失败。',
        )
        break
      }
    }
    if (next)
      result.nextPageCursor = JSON.stringify({
        user: id,
        mode: 'session',
        cursor: next,
      })
  }
}
