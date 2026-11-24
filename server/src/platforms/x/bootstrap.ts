import { Buffer } from 'node:buffer'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { ProviderError, responseError } from './provider.ts'
import type { SessionCredential } from './credential.ts'

export const accountUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

// Parse JSON only; never evaluate JavaScript returned by the platform.
export function bootstrapIdentity(html: string) {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html)
  const invalid = () =>
    new ProviderError(status.FAILED_PRECONDITION, '账号验证页面格式已变化')
  if (!marker) throw invalid()
  const input = html.slice(marker.index + marker[0].length)
  if (input[0] !== '{') throw invalid()
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      let state: any
      try {
        state = JSON.parse(input.slice(0, i + 1))
      } catch {
        throw invalid()
      }
      if (state.session?.isRestrictedSession === true)
        throw new ProviderError(status.PERMISSION_DENIED, 'X 账号受限')
      const id = state.session?.user_id
      const user = state.entities?.users?.entities?.[id]
      if (
        state.session?.isLoaded !== true ||
        typeof id !== 'string' ||
        !/^\d+$/.test(id) ||
        typeof user?.screen_name !== 'string' ||
        !/^\w{1,50}$/.test(user.screen_name)
      )
        throw invalid()
      return { accountId: id, username: user.screen_name }
    }
  }
  throw invalid()
}

export async function accountBootstrap(
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const response = await upstream(fetcher, 'https://x.com/home', {
    headers: {
      cookie: `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      'user-agent': accountUserAgent,
    },
    signal,
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(
      response.headers.get('location') ?? '/',
      'https://x.com',
    )
    if (
      location.hostname === 'x.com' &&
      /\/(?:login|i\/flow\/login|i\/jf\/onboarding\/web)/.test(
        location.pathname,
      )
    ) {
      throw new ProviderError(
        status.UNAUTHENTICATED,
        'X 登录已失效，请重新添加账号授权',
      )
    }
    throw new ProviderError(status.UNAVAILABLE, '账号验证时被意外重定向')
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    await response.body?.cancel()
    throw new ProviderError(
      status.UNAVAILABLE,
      'X 要求浏览器验证，无法确认账号是否有效',
    )
  }
  if (!response.ok)
    throw responseError(response.status, response.headers.get('retry-after'))
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError(status.UNAVAILABLE, '账号验证响应为空')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2 << 20)
        throw new ProviderError(status.UNAVAILABLE, '账号验证响应过大')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const html = Buffer.concat(chunks).toString('utf8')
  return { html, identity: bootstrapIdentity(html) }
}
