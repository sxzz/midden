import { resolveR2Credentials, type S3Credentials } from '#cloudflare.ts'
import { BucketBlobStore } from './bucket-store.ts'
import { FsBlobStore } from './fs-store.ts'
import { cachePurge } from './purge.ts'
import { S3Bucket } from './s3.ts'
import type { CloudflareConfig, Config, R2Config } from '#config.ts'
import type { Logger } from '#log.ts'
import type { MediaSigner } from './signer.ts'

export function openBucketStore(options: {
  r2: R2Config
  cloudflare: CloudflareConfig
  /** Derived from the API token at startup (`resolveR2Credentials`). */
  credentials: S3Credentials
  mediaDir: string
  signer: MediaSigner
  logger: Logger
  /** Cloudflare's API; tests point this at a fake. */
  apiBase?: string
}): BucketBlobStore {
  const { r2, cloudflare, credentials, logger } = options
  return new BucketBlobStore({
    local: new FsBlobStore(options.mediaDir, options.signer),
    bucket: new S3Bucket({
      endpoint: r2.endpoint,
      bucket: r2.bucket,
      ...credentials,
    }),
    publicUrl: r2.publicUrl,
    purge: cachePurge({
      zoneId: cloudflare.zoneId,
      token: cloudflare.apiToken,
      logger,
      apiBase: options.apiBase,
    }),
  })
}

/**
 * The R2 store, after verifying the API token; rejects with a configuration
 * error when that fails.
 */
export async function openR2Store(
  config: Pick<Config, 'cloudflare' | 'mediaDir'>,
  r2: R2Config,
  signer: MediaSigner,
  logger: Logger,
): Promise<BucketBlobStore> {
  // loadConfig requires the token and account with MEDIA_STORE=r2.
  const cloudflare = config.cloudflare!
  const credentials = await resolveR2Credentials(cloudflare, logger)
  return openBucketStore({
    r2,
    cloudflare,
    credentials,
    mediaDir: config.mediaDir,
    signer,
    logger,
  })
}

/** The configured media store. */
export function openMediaStore(
  config: Pick<Config, 'media' | 'cloudflare' | 'mediaDir'>,
  signer: MediaSigner,
  logger: Logger,
): Promise<FsBlobStore | BucketBlobStore> {
  return config.media.store === 'r2'
    ? openR2Store(config, config.media.r2, signer, logger)
    : Promise.resolve(new FsBlobStore(config.mediaDir, signer))
}
