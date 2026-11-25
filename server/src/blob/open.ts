import { BucketBlobStore } from './bucket-store.ts'
import { FsBlobStore } from './fs-store.ts'
import { cachePurge } from './purge.ts'
import { S3Bucket } from './s3.ts'
import type { MediaConfig, R2Config } from '#config.ts'
import type { Logger } from '#log.ts'
import type { MediaSigner } from './signer.ts'

export function openBucketStore(
  r2: R2Config,
  mediaDir: string,
  signer: MediaSigner,
  logger: Logger,
): BucketBlobStore {
  return new BucketBlobStore({
    local: new FsBlobStore(mediaDir, signer),
    bucket: new S3Bucket({
      endpoint: r2.endpoint,
      bucket: r2.bucket,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    }),
    publicUrl: r2.publicUrl,
    purge: cachePurge({ ...r2.purge, logger }),
  })
}

/** The configured media store. */
export function openMediaStore(
  media: MediaConfig,
  mediaDir: string,
  signer: MediaSigner,
  logger: Logger,
): FsBlobStore | BucketBlobStore {
  return media.store === 'r2'
    ? openBucketStore(media.r2, mediaDir, signer, logger)
    : new FsBlobStore(mediaDir, signer)
}
