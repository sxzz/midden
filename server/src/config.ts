import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'

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
  // Credentials: validators here never echo the value.
  R2_ACCESS_KEY_ID: v.optional(
    v.pipe(v.string(), v.nonEmpty('R2_ACCESS_KEY_ID is empty')),
  ),
  R2_SECRET_ACCESS_KEY: v.optional(
    v.pipe(v.string(), v.nonEmpty('R2_SECRET_ACCESS_KEY is empty')),
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
  // Cloudflare zone of MEDIA_PUBLIC_URL and a token allowed to purge it.
  CF_ZONE_ID: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{32}$/, 'CF_ZONE_ID must be 32 hex digits'),
    ),
  ),
  CF_PURGE_TOKEN: v.optional(
    v.pipe(v.string(), v.nonEmpty('CF_PURGE_TOKEN is empty')),
  ),
  // The Litestream sidecar's bucket token (compose.yaml); only its presence
  // matters here: the server then expects the sidecar's heartbeats.
  LITESTREAM_ACCESS_KEY_ID: v.optional(v.string()),
})

const TRAILING_SLASHES = /\/+$/

const R2_SETTINGS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'MEDIA_PUBLIC_URL',
] as const

export interface R2Config {
  /** The S3 API, which the server alone uses. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Where browsers read originals, without a trailing slash. */
  publicUrl: string
  /** Edge cache purging on deletion; skipped when absent. */
  purge?: { zoneId: string; token: string }
}

export type MediaConfig = { store: 'local' } | { store: 'r2'; r2: R2Config }

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
  if (!!parsed.CF_ZONE_ID !== !!parsed.CF_PURGE_TOKEN)
    throw new Error(
      'Invalid configuration:\nCF_ZONE_ID and CF_PURGE_TOKEN are set together',
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
      accessKeyId: parsed.R2_ACCESS_KEY_ID!,
      secretAccessKey: parsed.R2_SECRET_ACCESS_KEY!,
      publicUrl: parsed.MEDIA_PUBLIC_URL!.replace(TRAILING_SLASHES, ''),
      ...(parsed.CF_ZONE_ID && parsed.CF_PURGE_TOKEN
        ? { purge: { zoneId: parsed.CF_ZONE_ID, token: parsed.CF_PURGE_TOKEN } }
        : {}),
    },
  }
}
