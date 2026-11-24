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
  // Public HTTPS address of the web app (ending in /app/); enables cookie
  // sessions and is the only origin allowed to write with them.
  WEB_APP_URL: v.optional(
    v.pipe(v.string(), v.url(), v.regex(/^https:\/\/[^/?#]+\/app\/$/)),
  ),
  // The built web app served under /app/.
  WEB_DIR: v.optional(v.pipe(v.string(), v.nonEmpty())),
  FFMPEG: v.optional(v.pipe(v.string(), v.nonEmpty()), 'ffmpeg'),
  SECRET_KEY: v.pipe(
    v.string('SECRET_KEY is required'),
    v.minLength(32, 'SECRET_KEY must be at least 32 characters'),
  ),
})

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
  }
}
