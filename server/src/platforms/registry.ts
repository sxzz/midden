import { AppError } from '#errors.ts'
import { isProviderFailure, type Platform } from './platform.ts'
import { status } from './rpc.ts'
import type { Provider, ResolveResponse } from './protocol.ts'

export function supports(provider: Provider, name: string, major = 1): boolean {
  return provider.capabilities.some((c) => c.name === name && c.major === major)
}

/** The platforms this server captures from, routed by URL host. */
export class Platforms {
  readonly #byId = new Map<string, Platform>()
  readonly #byHost = new Map<string, Platform>()

  constructor(platforms: Platform[]) {
    for (const platform of platforms) {
      const id = platform.description.adapterId
      if (this.#byId.has(id)) throw new Error(`duplicate platform ${id}`)
      this.#byId.set(id, platform)
      for (const host of platform.description.hosts) {
        const key = host.toLowerCase()
        if (this.#byHost.has(key)) throw new Error(`ambiguous host ${host}`)
        this.#byHost.set(key, platform)
      }
    }
  }

  all(): Platform[] {
    return [...this.#byId.values()]
  }

  byId(id: string): Platform {
    const platform = this.#byId.get(id)
    if (!platform) throw new AppError('unsupported', `unknown platform ${id}`)
    return platform
  }

  /** The platform for a URL and its resolved target. */
  resolve(raw: string): { platform: Platform; target: ResolveResponse } {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      throw new AppError('invalid_target')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      throw new AppError('invalid_target')
    const platform = this.#byHost.get(url.hostname.toLowerCase())
    if (!platform) throw new AppError('invalid_target')
    let target: ResolveResponse
    try {
      target = platform.resolve(raw)
    } catch (error) {
      if (isProviderFailure(error) && error.code === status.INVALID_ARGUMENT)
        throw new AppError('invalid_target')
      throw error
    }
    if (
      !URL.canParse(target.url) ||
      !target.platform ||
      !target.kind ||
      !target.externalId
    )
      throw new Error('平台返回的链接无效')
    return { platform, target }
  }
}

export function provider(platform: Platform, id: string): Provider {
  const found = platform.description.providers.find((p) => p.id === id)
  if (!found) throw new AppError('unsupported')
  return found
}

/**
 * The default provider for an authentication mode. Asking for anonymous
 * capture on a platform that only works with an account is
 * `account_required`.
 */
export function defaultProvider(
  platform: Platform,
  authentication: 'none' | 'session',
): Provider {
  const providers = platform.description.providers
  const matches = providers.filter(
    (p) => p.defaultProvider && p.authentication === authentication,
  )
  if (matches.length > 1) throw new Error('ambiguous default provider')
  if (matches[0]) return matches[0]
  if (
    authentication === 'none' &&
    providers.some((p) => p.defaultProvider && p.authentication === 'session')
  )
    throw new AppError('account_required')
  throw new AppError('unsupported')
}
