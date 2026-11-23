import { Buffer } from 'node:buffer'
import { createDecipheriv } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../../../server/src/capture/json.ts'
import type { AssetState } from '../../../server/src/capture/finalize.ts'
import type { CaptureOptions } from '../../../server/src/capture/options.ts'
import type { Payload } from '../../../server/src/capture/payload.ts'
import type { StoredTarget } from '../../../server/src/capture/related.ts'

/** A related target as the Go service marshalled it (protobuf JSON tags). */
interface LegacyTarget {
  url?: string
  refresh_after_seconds?: number
  updated_at?: string
  /** Base64, as Go encodes []byte. */
  prefetch?: string
  published_at?: string
  media_types?: string[]
  post_type?: string
}

/** Go marshalled an empty list as `null`; fields are omitted when empty. */
export function convertTargets(value: unknown): StoredTarget[] {
  if (!Array.isArray(value)) return []
  return (value as LegacyTarget[]).map((target) => ({
    url: target.url ?? '',
    refreshAfterSeconds: target.refresh_after_seconds ?? 0,
    updatedAt: target.updated_at ?? '',
    publishedAt: target.published_at ?? '',
    mediaTypes: target.media_types ?? [],
    postType: target.post_type ?? '',
    ...(target.prefetch ? { prefetch: target.prefetch } : {}),
  }))
}

interface LegacyOptions {
  media_only?: boolean
  omit_shared?: boolean
  skip_references?: boolean
  max_posts?: number
  since?: string
}

export function convertOptions(value: unknown): CaptureOptions | null {
  if (!value || typeof value !== 'object') return null
  const options = value as LegacyOptions
  return {
    ...(options.media_only ? { mediaOnly: true } : {}),
    ...(options.omit_shared ? { omitShared: true } : {}),
    ...(options.skip_references ? { skipReferences: true } : {}),
    ...(options.max_posts ? { maxPosts: options.max_posts } : {}),
    ...(options.since ? { since: options.since } : {}),
  }
}

/**
 * A Go payload in the new form: the same snake_case fields, without the JSON
 * Schema each graph entity carried, and with entity versions that merged
 * into another pointed at the one kept.
 */
export function convertPayload(
  value: unknown,
  versions: ReadonlyMap<string, string>,
): Payload {
  const payload = structuredClone(value) as Payload
  for (const entity of payload.graph?.entities ?? []) {
    delete (entity as { schema?: unknown }).schema
    if (entity.version_id)
      entity.version_id = versions.get(entity.version_id) ?? entity.version_id
  }
  return payload
}

/** The media part of an entity version's content hash (`persistEntities`). */
export function entityMedia(
  indices: readonly number[],
  assets: readonly AssetState[],
): unknown[] {
  const byPosition = new Map<number, AssetState>()
  for (const asset of assets)
    if (!byPosition.has(asset.position)) byPosition.set(asset.position, asset)
  return indices.map((index) => {
    const asset = byPosition.get(index)
    return asset
      ? [
          asset.purpose,
          asset.hash,
          asset.state,
          asset.altText,
          asset.sensitive,
          asset.error,
        ]
      : null
  })
}

export function entityVersionHash(data: unknown, media: unknown[]): string {
  return sha256Hex(canonicalJson([data, media]))
}

/** Context entities' identities, as `finalize` derives them. */
export function contextOf(payload: Payload): Set<string> {
  return new Set(
    (payload.graph?.entities ?? [])
      .filter((entity) => entity.context_only)
      .map((entity) => `${entity.type}/${entity.external_id}`),
  )
}

const NONCE = 12
const TAG = 16

/** Decrypt a credential sealed by Go's `credentials.Vault`. */
export function openLegacyCredential(
  key: Uint8Array,
  tenant: string,
  ref: string,
  sealed: Uint8Array,
): Buffer {
  if (sealed.length < NONCE + TAG)
    throw new Error(`credential ${ref} is too short`)
  const data = Buffer.from(sealed)
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, NONCE))
  decipher.setAAD(Buffer.from(`${tenant}:${ref}`))
  decipher.setAuthTag(data.subarray(data.length - TAG))
  try {
    return Buffer.concat([
      decipher.update(data.subarray(NONCE, data.length - TAG)),
      decipher.final(),
    ])
  } catch (error) {
    throw new Error(
      `cannot decrypt credential ${ref}; is CREDENTIAL_KEY right?`,
      { cause: error },
    )
  }
}

export function parseCredentialKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64')
  if (key.length !== 32)
    throw new Error('CREDENTIAL_KEY must be base64-encoded 32 bytes')
  return key
}
