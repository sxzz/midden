import { Buffer } from 'node:buffer'
import {
  fetchPrivateMediaInfo,
  fetchPrivateUserById,
  fetchPrivateUserByUsername,
  fetchPrivateUserFeed,
} from '@fxembed/atmosphere/providers/instagram/private-api'
import {
  mediaItemsFromPrivateFeed,
  nextMaxIdFromPrivateResponse,
} from '@fxembed/atmosphere/providers/instagram/private-processor'
import {
  InstagramSessionError,
  InstagramSessionProvider,
} from '@fxembed/atmosphere/providers/instagram/session'
import { instagramShortcodeToPk } from '@fxembed/atmosphere/providers/instagram/shortcode'
import { rateLimitedKey } from '../platform.ts'
import { SourceResponse, Visibility } from '../protocol.ts'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { ProviderError, responseError } from './errors.ts'
import type { SessionCredential } from './credential.ts'
import type { InstagramRequestContext } from '@fxembed/atmosphere/providers/instagram/account-proxy'

export type Node = Record<string, any>
export interface Page {
  items: Node[]
  next: string
}

/** The Adapter owns transport limits and RPC errors; Atmosphere owns Instagram requests. */
export class InstagramClient {
  readonly sources: SourceResponse[] = []
  private bytes = 0
  private context: InstagramRequestContext
  readonly signal: AbortSignal
  readonly credential: SessionCredential
  private fetcher: typeof fetch
  private captureSources: boolean
  constructor(
    signal: AbortSignal,
    credential: SessionCredential,
    fetcher: typeof fetch = fetch,
    captureSources = true,
  ) {
    this.signal = signal
    this.credential = credential
    this.fetcher = fetcher
    this.captureSources = captureSources
    this.context = {
      session: new InstagramSessionProvider(credential, (url, init, capture) =>
        this.request(url, init, capture),
      ),
    }
  }

  private async request(url: string, options: RequestInit, capture: boolean) {
    const target = new URL(url)
    if (
      target.protocol !== 'https:' ||
      target.hostname !== 'www.instagram.com' ||
      target.port ||
      target.username ||
      target.password
    )
      throw new ProviderError(status.INVALID_ARGUMENT, 'Instagram 接口地址无效')
    if (!this.credential?.sessionId)
      throw new ProviderError(
        status.FAILED_PRECONDITION,
        'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
      )
    let response: Response
    try {
      response = await upstream(this.fetcher, url, {
        ...options,
        redirect: 'manual',
        signal: this.signal,
      })
    } catch {
      throw new ProviderError(
        this.signal.aborted ? status.DEADLINE_EXCEEDED : status.UNAVAILABLE,
        'Instagram 请求失败',
      )
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new ProviderError(
        status.UNAUTHENTICATED,
        'Instagram 要求登录验证，请检查账号后重试',
      )
    }
    if (!response.ok || response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel()
      if (response.headers.get('cf-mitigated') === 'challenge')
        throw new ProviderError(
          status.PERMISSION_DENIED,
          'Instagram 要求浏览器验证，请检查账号后重试',
        )
      throw responseError(
        response.status,
        true,
        response.headers.get('retry-after'),
      )
    }
    const reader = response.body?.getReader()
    if (!reader)
      throw new ProviderError(status.UNAVAILABLE, 'Instagram 返回了空响应')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 2 << 20)
          throw new ProviderError(
            status.RESOURCE_EXHAUSTED,
            'Instagram 响应超出上限',
          )
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(
        this.signal.aborted ? status.DEADLINE_EXCEEDED : status.UNAVAILABLE,
        'Instagram 响应被中断',
      )
    } finally {
      await reader.cancel().catch(() => {})
    }
    const body = Buffer.concat(chunks)
    if (capture && this.captureSources) {
      // The core's source contract is JSON. Preserve non-JSON bytes losslessly in an envelope.
      let sourceBody = body
      try {
        JSON.parse(body.toString('utf8'))
      } catch {
        sourceBody = Buffer.from(
          JSON.stringify({
            content_type:
              response.headers.get('content-type') ??
              'application/octet-stream',
            encoding: 'base64',
            body: body.toString('base64'),
          }),
        )
      }
      if (this.sources.length >= 16 || this.bytes + sourceBody.length > 4 << 20)
        throw new ProviderError(
          status.RESOURCE_EXHAUSTED,
          'Instagram 原始响应超出上限',
        )
      this.sources.push(
        SourceResponse.fromPartial({
          body: sourceBody,
          contentType: 'application/json',
          sourceUrl: url,
          visibility: Visibility.VISIBILITY_PRIVATE,
        }),
      )
      this.bytes += sourceBody.length
    }
    return { text: body.toString('utf8'), response }
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof InstagramSessionError)) throw error
      const codes: Record<number, status> = {
        400: status.INVALID_ARGUMENT,
        401: status.UNAUTHENTICATED,
        403: status.PERMISSION_DENIED,
        404: status.NOT_FOUND,
        429: status.RESOURCE_EXHAUSTED,
      }
      // Atmosphere words its errors in English; ours say the same by status.
      const failure = new ProviderError(
        codes[error.status] ?? status.UNAVAILABLE,
        error.status === 400
          ? 'Instagram 返回的数据无效'
          : responseError(error.status, true).message,
        error.retryAfter,
      )
      if (error.status === 429) failure.metadata.set(rateLimitedKey, '1')
      throw failure
    }
  }

  async post(id: string): Promise<Node> {
    const result = await this.operation(() =>
      fetchPrivateMediaInfo(id, this.context),
    )
    return (result.json as Node).items[0]
  }
  async profile(id: string): Promise<Node> {
    const result = await this.operation(() =>
      /^\d+$/.test(id)
        ? fetchPrivateUserById(id, this.context)
        : fetchPrivateUserByUsername(
            id.startsWith('handle:') ? id.slice(7) : '',
            this.context,
          ),
    )
    return (result.json as Node).user
  }
  async page(user: Node, cursor: string, count: number): Promise<Page> {
    const result = await this.operation(() =>
      fetchPrivateUserFeed(String(user.pk ?? user.id), this.context, {
        maxId: cursor,
        count,
        username: user.username,
      }),
    )
    return {
      items: mediaItemsFromPrivateFeed(result.json),
      next: nextMaxIdFromPrivateResponse(result.json) ?? '',
    }
  }
  checkConnection(): Promise<{ accountId: string; username: string }> {
    return this.operation(() => this.context.session!.checkConnection())
  }
}

export function mediaId(node: Node): string {
  const value = String(node.pk ?? node.id ?? '').split('_', 1)[0]!
  if (/^\d+$/.test(value)) return value
  const shortcode = node.code ?? node.shortcode
  if (typeof shortcode !== 'string' || !/^[\w-]{1,20}$/.test(shortcode))
    return ''
  return String(instagramShortcodeToPk(shortcode))
}
