import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CloudflareConfig } from '#config.ts'
import type { Logger } from '#log.ts'

/** Cloudflare's REST API; tests point this at a fake. */
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT = 30_000
const ATTEMPTS = 3

export interface CloudflareOptions {
  fetch?: typeof fetch
  apiBase?: string
  /** Base delay between attempts. */
  retryDelayMs?: number
}

/** An S3 key pair for R2. */
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

interface Envelope<T> {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: T
}

/** Cloudflare's error list as one line; it never carries the token. */
export function envelopeErrors(body: Envelope<unknown> | undefined): string {
  return (body?.errors ?? [])
    .map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim())
    .join('; ')
}

/**
 * The id of an account API token, from the account's token verify endpoint.
 * Network errors, 5xx and 429 are tried again; a rejected token is not.
 * Errors name the status and Cloudflare's messages, never the token.
 */
export async function verifyToken(
  cloudflare: Pick<CloudflareConfig, 'accountId' | 'apiToken'>,
  options: CloudflareOptions = {},
): Promise<string> {
  const send = options.fetch ?? fetch
  const url = `${options.apiBase ?? CLOUDFLARE_API}/accounts/${cloudflare.accountId}/tokens/verify`
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep((attempt - 1) * (options.retryDelayMs ?? 1000))
    let response: Response
    try {
      response = await send(url, {
        headers: { Authorization: `Bearer ${cloudflare.apiToken}` },
        signal: AbortSignal.timeout(TIMEOUT),
      })
    } catch (error) {
      lastError = new Error(`token verify request failed: ${String(error)}`)
      continue
    }
    const body = (await response.json().catch(() => undefined)) as
      Envelope<{ id?: string; status?: string }> | undefined
    const errors = envelopeErrors(body)
    const result = body?.result
    if (response.ok && body?.success && result?.id) {
      if (result.status !== 'active')
        throw new Error(`token is ${result.status ?? 'not active'}`)
      return result.id
    }
    lastError = new Error(
      `token verify failed: ${response.status}${errors ? ` ${errors}` : ''}`,
    )
    if (response.status < 500 && response.status !== 429) break
  }
  throw lastError!
}

/**
 * R2's S3 credentials for an API token: the token's id is the access key
 * id, and the SHA-256 of its value (hex) the secret access key
 * (https://developers.cloudflare.com/r2/api/tokens/).
 */
export function r2Credentials(tokenId: string, token: string): S3Credentials {
  return {
    accessKeyId: tokenId,
    secretAccessKey: createHash('sha256').update(token).digest('hex'),
  }
}

/**
 * Verify the token once at startup and derive the S3 keys from it. A
 * failure is a configuration error: the server must not start without
 * working R2 credentials, so a deploy that lacks them fails its health check
 * and is rolled back.
 */
export async function resolveR2Credentials(
  cloudflare: CloudflareConfig,
  logger: Logger,
  options: CloudflareOptions = {},
): Promise<S3Credentials> {
  try {
    const id = await verifyToken(cloudflare, options)
    logger.info('cloudflare token verified')
    return r2Credentials(id, cloudflare.apiToken)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.error({ reason }, 'cloudflare token verification failed')
    throw new Error(
      `Invalid configuration:\nCF_API_TOKEN could not be verified: ${reason}`,
      { cause: error },
    )
  }
}
