import type { Logger } from '#log.ts'

export interface PurgeOptions {
  zoneId?: string
  /** An API token with the zone's Cache Purge permission. */
  token?: string
  logger: Logger
  fetch?: typeof fetch
  /** Overridden in tests. */
  apiBase?: string
}

const API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT = 30_000

/** Drops URLs from Cloudflare's edge cache. */
export type Purge = (url: string) => Promise<void>

/**
 * Cached copies outlive a deleted object, so a deletion purges its public
 * URL. Without a token the purge is skipped and logged.
 */
export function cachePurge(options: PurgeOptions): Purge {
  const { zoneId, token, logger } = options
  if (!zoneId || !token)
    return (url) => {
      logger.warn({ url }, 'cache purge skipped: no purge token configured')
      return Promise.resolve()
    }
  const endpoint = `${options.apiBase ?? API}/zones/${zoneId}/purge_cache`
  const send = options.fetch ?? fetch
  return async (url) => {
    const response = await send(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: [url] }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const body = (await response.json().catch(() => undefined)) as
      | { success?: boolean; errors?: { code?: number; message?: string }[] }
      | undefined
    if (!response.ok || !body?.success) {
      const errors = (body?.errors ?? [])
        .map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim())
        .join('; ')
      throw new Error(
        `cache purge failed: ${response.status}${errors ? ` ${errors}` : ''}`,
      )
    }
    logger.info({ url }, 'cache purged')
  }
}
