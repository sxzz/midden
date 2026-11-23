import path from 'node:path'
import process from 'node:process'
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
  FFMPEG: v.optional(v.pipe(v.string(), v.nonEmpty()), 'ffmpeg'),
  SECRET_KEY: v.pipe(
    v.string('SECRET_KEY is required'),
    v.minLength(32, 'SECRET_KEY must be at least 32 characters'),
  ),
})

export interface Config {
  dataDir: string
  databasePath: string
  mediaDir: string
  host: string
  port: number
  logLevel: v.InferOutput<typeof Env>['LOG_LEVEL']
  secretKey: string
  ffmpeg: string
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
  const dataDir = path.resolve(parsed.DATA_DIR)
  return {
    dataDir,
    databasePath: path.join(dataDir, 'midden.db'),
    mediaDir: path.join(dataDir, 'media'),
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    secretKey: parsed.SECRET_KEY,
    ffmpeg: parsed.FFMPEG,
  }
}
