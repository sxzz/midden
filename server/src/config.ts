import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'
import type { S3Credentials } from '#cloudflare.ts'

const port = v.pipe(
  v.optional(v.string(), '8080'),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
  v.maxValue(65_535),
)

const Env = v.object({
  DATA_DIR: v.optional(v.pipe(v.string(), v.nonEmpty()), 'data'),
  HOST: v.optional(v.pipe(v.string(), v.nonEmpty()), '0.0.0.0'),
  PORT: port,
  LOG_LEVEL: v.optional(
    v.picklist(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    'info',
  ),
  // Root secret for every derived key (credential encryption, media URL
  // signatures). Rotating it invalidates stored credentials.
  // The bot that signs Telegram logins; web login is off without it.
  TELEGRAM_BOT_TOKEN: v.optional(v.pipe(v.string(), v.regex(/^\d+:[\w-]+$/))),
  // The only Telegram user allowed in.
  OWNER_TELEGRAM_ID: v.optional(v.pipe(v.string(), v.regex(/^\d+$/))),
  // Public HTTPS address of the web app (ending in /app/), opened as the
  // Mini App; enables cookie sessions.
  WEB_APP_URL: v.optional(
    v.pipe(v.string(), v.url(), v.regex(/^https:\/\/[^/?#]+\/app\/$/)),
  ),
  // The built web app served under /app/.
  WEB_DIR: v.optional(v.pipe(v.string(), v.nonEmpty())),
  FFMPEG: v.optional(v.pipe(v.string(), v.nonEmpty()), 'ffmpeg'),
  // Docker sets it to production; the dev server leaves it unset.
  NODE_ENV: v.optional(v.string()),
  SECRET_KEY: v.pipe(
    v.string('SECRET_KEY is required'),
    v.minLength(32, 'SECRET_KEY must be at least 32 characters'),
  ),
  // Where media originals go: this directory only, or also Cloudflare R2.
  MEDIA_STORE: v.optional(
    v.picklist(['local', 'r2'], 'MEDIA_STORE must be local or r2'),
    'local',
  ),
  R2_ACCOUNT_ID: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{32}$/, 'R2_ACCOUNT_ID must be 32 hex digits'),
    ),
  ),
  R2_BUCKET: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
        'R2_BUCKET must be a bucket name',
      ),
    ),
  ),
  // One Cloudflare account API token for everything the server does there:
  // R2 objects (its S3 keys derive from it), cache purge and analytics.
  // Validators here never echo the value.
  CF_API_TOKEN: v.optional(
    v.pipe(v.string(), v.nonEmpty('CF_API_TOKEN is empty')),
  ),
  // The bucket's public custom domain; an object's URL is this plus its key.
  MEDIA_PUBLIC_URL: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^https:\/\/[^/?#]+(?:\/[^?#]*)?$/,
        'MEDIA_PUBLIC_URL must be an https URL without query',
      ),
    ),
  ),
  // Cloudflare zone of MEDIA_PUBLIC_URL, purged with CF_API_TOKEN.
  CF_ZONE_ID: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{32}$/, 'CF_ZONE_ID must be 32 hex digits'),
    ),
  ),
  // A private bucket for raw upstream responses, in the same R2 account; the
  // database keeps them when unset. Never the public media bucket: they
  // hold what the platform showed the signed-in account. Its S3 keys are
  // the pair below, or else derive from CF_API_TOKEN.
  RAW_R2_BUCKET: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
        'RAW_R2_BUCKET must be a bucket name',
      ),
    ),
  ),
  RAW_R2_ACCESS_KEY_ID: v.optional(
    v.pipe(v.string(), v.nonEmpty('RAW_R2_ACCESS_KEY_ID is empty')),
  ),
  RAW_R2_SECRET_ACCESS_KEY: v.optional(
    v.pipe(v.string(), v.nonEmpty('RAW_R2_SECRET_ACCESS_KEY is empty')),
  ),
  // The Litestream sidecar's bucket token (compose.yaml); only its presence
  // matters here: the server then expects the sidecar's heartbeats.
  LITESTREAM_ACCESS_KEY_ID: v.optional(v.string()),
})

const TRAILING_SLASHES = /\/+$/

const R2_SETTINGS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'CF_API_TOKEN',
  'MEDIA_PUBLIC_URL',
] as const

/** The Cloudflare account and its API token (`#cloudflare.ts`). */
export interface CloudflareConfig {
  accountId: string
  apiToken: string
  /** The zone of the media domain, for cache purges. */
  zoneId?: string
}

export interface R2Config {
  /** The S3 API, which the server alone uses. */
  endpoint: string
  bucket: string
  /** Where browsers read originals, without a trailing slash. */
  publicUrl: string
}

export type MediaConfig = { store: 'local' } | { store: 'r2'; r2: R2Config }

/** The private bucket raw responses move to (`raw/`). */
export interface RawConfig {
  endpoint: string
  bucket: string
  /** Its own S3 keys; without them, R2's keys from CF_API_TOKEN. */
  credentials?: S3Credentials
}

export interface Config {
  dataDir: string
  databasePath: string
  /** Also written to stdout; this copy outlives the container. */
  logFile: string
  mediaDir: string
  host: string
  port: number
  logLevel: v.InferOutput<typeof Env>['LOG_LEVEL']
  secretKey: string
  ffmpeg: string
  webDir: string
  telegram?: { token: string; owner: string }
  webAppUrl?: string
  media: MediaConfig
  /**
   * R2's S3 keys derive from the token (`r2Credentials`), which also purges
   * the edge cache and reads the storage analytics.
   */
  cloudflare?: CloudflareConfig
  /** Where raw responses go once stored; unset, they stay in the database. */
  raw?: RawConfig
  /** Litestream replicates the database: watch for its heartbeats. */
  litestream: boolean
  /**
   * Development mode: anywhere NODE_ENV is not `production`, which the
   * image sets. Unlocks tools that would hurt real data, such as deleting
   * everything.
   */
  dev: boolean
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = v.safeParse(Env, env)
  if (!result.success) {
    const issues = result.issues.map((issue) => {
      const key = v.getDotPath(issue)
      return key ? `${key}: ${issue.message}` : issue.message
    })
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`)
  }
  const parsed = result.output
  if (!!parsed.TELEGRAM_BOT_TOKEN !== !!parsed.OWNER_TELEGRAM_ID)
    throw new Error(
      'Invalid configuration:\nTELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_ID are set together',
    )
  const dataDir = path.resolve(parsed.DATA_DIR)
  return {
    dataDir,
    databasePath: path.join(dataDir, 'midden.db'),
    logFile: path.join(dataDir, 'logs', 'midden.log'),
    mediaDir: path.join(dataDir, 'media'),
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    secretKey: parsed.SECRET_KEY,
    ffmpeg: parsed.FFMPEG,
    webDir: path.resolve(
      parsed.WEB_DIR ??
        fileURLToPath(new URL('../../web/dist', import.meta.url)),
    ),
    ...(parsed.TELEGRAM_BOT_TOKEN && parsed.OWNER_TELEGRAM_ID
      ? {
          telegram: {
            token: parsed.TELEGRAM_BOT_TOKEN,
            owner: parsed.OWNER_TELEGRAM_ID,
          },
        }
      : {}),
    ...(parsed.WEB_APP_URL ? { webAppUrl: parsed.WEB_APP_URL } : {}),
    media: mediaConfig(parsed),
    ...(parsed.R2_ACCOUNT_ID && parsed.CF_API_TOKEN
      ? {
          cloudflare: {
            accountId: parsed.R2_ACCOUNT_ID,
            apiToken: parsed.CF_API_TOKEN,
            ...(parsed.CF_ZONE_ID ? { zoneId: parsed.CF_ZONE_ID } : {}),
          },
        }
      : {}),
    ...rawConfig(parsed),
    litestream: !!parsed.LITESTREAM_ACCESS_KEY_ID,
    dev: parsed.NODE_ENV !== 'production',
  }
}

function mediaConfig(parsed: v.InferOutput<typeof Env>): MediaConfig {
  if (parsed.MEDIA_STORE === 'local') return { store: 'local' }
  const missing = R2_SETTINGS.filter((name) => !parsed[name])
  if (missing.length)
    throw new Error(
      `Invalid configuration:\nMEDIA_STORE=r2 needs ${missing.join(', ')}`,
    )
  return {
    store: 'r2',
    r2: {
      endpoint: `https://${parsed.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: parsed.R2_BUCKET!,
      publicUrl: parsed.MEDIA_PUBLIC_URL!.replace(TRAILING_SLASHES, ''),
    },
  }
}

function rawConfig(parsed: v.InferOutput<typeof Env>): { raw?: RawConfig } {
  const id = parsed.RAW_R2_ACCESS_KEY_ID
  const secret = parsed.RAW_R2_SECRET_ACCESS_KEY
  if (!!id !== !!secret)
    throw new Error(
      'Invalid configuration:\nRAW_R2_ACCESS_KEY_ID and RAW_R2_SECRET_ACCESS_KEY are set together',
    )
  if (!parsed.RAW_R2_BUCKET) {
    if (id)
      throw new Error(
        'Invalid configuration:\nRAW_R2_ACCESS_KEY_ID needs RAW_R2_BUCKET',
      )
    return {}
  }
  const missing = [
    ...(parsed.R2_ACCOUNT_ID ? [] : ['R2_ACCOUNT_ID']),
    ...(id || parsed.CF_API_TOKEN
      ? []
      : [
          'CF_API_TOKEN (or RAW_R2_ACCESS_KEY_ID and RAW_R2_SECRET_ACCESS_KEY)',
        ]),
  ]
  if (missing.length)
    throw new Error(
      `Invalid configuration:\nRAW_R2_BUCKET needs ${missing.join(', ')}`,
    )
  if (parsed.RAW_R2_BUCKET === parsed.R2_BUCKET)
    throw new Error(
      'Invalid configuration:\nRAW_R2_BUCKET must not be the public media bucket R2_BUCKET',
    )
  return {
    raw: {
      endpoint: `https://${parsed.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: parsed.RAW_R2_BUCKET,
      ...(id && secret
        ? { credentials: { accessKeyId: id, secretAccessKey: secret } }
        : {}),
    },
  }
}
