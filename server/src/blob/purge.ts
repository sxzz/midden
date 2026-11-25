import { CLOUDFLARE_API, envelopeErrors } from '#cloudflare.ts'
import type { Logger } from '#log.ts'

export interface PurgeOptions {
  /** The zone of the public media domain; without it nothing is purged. */
  zoneId?: string
  /** CF_API_TOKEN, which has the zone's Cache Purge permission. */
  token: string
  logger: Logger
  fetch?: typeof fetch
  /** Overridden in tests. */
  apiBase?: string
}

const TIMEOUT = 30_000

/** Drops URLs from Cloudflare's edge cache. */
export type Purge = (url: string) => Promise<void>

/**
 * Cached copies outlive a deleted object, so a deletion purges its public
 * URL. Without the zone the purge is skipped and logged.
 */
export function cachePurge(options: PurgeOptions): Purge {
  const { zoneId, token, logger } = options
  if (!zoneId)
    return (url) => {
      logger.warn({ url }, 'cache purge skipped: no CF_ZONE_ID configured')
      return Promise.resolve()
    }
  const endpoint = `${options.apiBase ?? CLOUDFLARE_API}/zones/${zoneId}/purge_cache`
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
      const errors = envelopeErrors(body)
      throw new Error(
        `cache purge failed: ${response.status}${errors ? ` ${errors}` : ''}`,
      )
    }
    logger.info({ url }, 'cache purged')
  }
}
