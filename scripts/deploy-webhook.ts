#!/usr/bin/env node
// Receive GitHub webhooks and deploy when the test workflow, which publishes
// the image, succeeds for a push to main. The payload is only a trigger:
// deploy.ts, taken from origin/main at that moment, resolves the release.
// Installed outside the checkout by install-deploy-webhook.ts.
/* eslint-disable unicorn/no-exports-in-scripts -- for deploy-webhook.test.ts */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseEnv } from 'node:util'

const PATH = '/hooks/deploy'
const MAX_BODY = 1 << 20

function verifySignature(
  secret: string,
  body: Buffer,
  header: unknown,
): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  )
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

interface WorkflowRunEvent {
  action?: string
  repository?: { full_name?: string }
  workflow_run?: {
    name?: string
    conclusion?: string
    event?: string
    head_branch?: string
  }
}

/** The test workflow publishes the image only for pushes to main. */
function isRelease(
  event: unknown,
  payload: WorkflowRunEvent,
  repository: string,
): boolean {
  const run = payload.workflow_run
  return (
    event === 'workflow_run' &&
    payload.action === 'completed' &&
    payload.repository?.full_name === repository &&
    run?.name === 'test' &&
    run.conclusion === 'success' &&
    run.event === 'push' &&
    run.head_branch === 'main'
  )
}

/** One deployment at a time; triggers during a run collapse into one rerun. */
function createDeployer(deploy: () => Promise<void>): () => void {
  let running = false
  let pending = false
  const loop = async () => {
    running = true
    do {
      pending = false
      await deploy()
    } while (pending)
    running = false
  }
  return () => {
    if (running) pending = true
    else
      loop().catch((error: unknown) => {
        running = false
        warn(
          `deployment crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        )
      })
  }
}

function createHandler(options: {
  secret: string
  repository: string
  trigger: () => void
}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, text = '') => {
      res.writeHead(status, { 'Content-Type': 'text/plain' })
      res.end(text)
    }
    if (req.url !== PATH) return reply(404)
    if (req.method !== 'POST') return reply(405)
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reply(413)
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      const body = Buffer.concat(chunks)
      if (
        !verifySignature(
          options.secret,
          body,
          req.headers['x-hub-signature-256'],
        )
      )
        return reply(401)
      const event = req.headers['x-github-event']
      if (event === 'ping') return reply(200, 'pong')
      let payload: WorkflowRunEvent
      try {
        payload = JSON.parse(body.toString('utf8'))
      } catch {
        return reply(400)
      }
      if (!isRelease(event, payload, options.repository)) return reply(204)
      options.trigger()
      reply(202, 'deployment scheduled')
    })
  }
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; log?: WriteStream },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output += chunk
        options.log?.write(chunk)
      })
    child.on('error', (error) =>
      resolve({ code: 1, output: `${output}${error.message}` }),
    )
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

const COMMIT = /\b[\da-f]{40}\b/g

interface TextLink {
  type: 'text_link'
  offset: number
  length: number
  url: string
}

/**
 * Commit shas in `text` shortened to 7 characters and linked to the commit
 * on GitHub through `text_link` entities, so the text needs no escaping.
 */
function linkCommits(
  text: string,
  repository: string,
): { text: string; entities: TextLink[] } {
  const entities: TextLink[] = []
  let out = ''
  let last = 0
  for (const match of text.matchAll(COMMIT)) {
    out += text.slice(last, match.index)
    const short = match[0].slice(0, 7)
    // Offsets count UTF-16 code units, as JavaScript string lengths do.
    entities.push({
      type: 'text_link',
      offset: out.length,
      length: short.length,
      url: `https://github.com/${repository}/commit/${match[0]}`,
    })
    out += short
    last = match.index + match[0].length
  }
  return { text: out + text.slice(last), entities }
}

const ATTEMPT_TIMEOUT = 10_000
// Waits before the 2nd, 3rd and 4th attempt.
const BACKOFF = [2000, 5000, 15_000]
// A longer retry_after than this is not worth holding the deployment for.
const MAX_RETRY_AFTER = 60_000

export interface TelegramDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  /** Called with a line for every failed attempt; never contains secrets. */
  log: (line: string) => void
  timeout?: number
}

/** stderr line with an ISO timestamp, for the service's log. */
export function warn(line: string): void {
  console.error(`${new Date().toISOString()} ${line}`)
}

/** `fetch failed` hides the reason in `cause`; spell it out. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [`${error.name}: ${error.message}`]
  const cause = error.cause as
    | (Error & { code?: string; errors?: (Error & { code?: string })[] })
    | undefined
  if (cause) {
    parts.push(
      `cause.code=${cause.code ?? 'none'}`,
      `cause.message=${cause.message ?? String(cause)}`,
    )
    // Dual-stack connect failures are an AggregateError, one per address.
    for (const inner of cause.errors ?? [])
      parts.push(`[${inner.code ?? inner.name}: ${inner.message}]`)
  }
  return parts.join(' ')
}

/**
 * Post to Telegram's sendMessage. Network errors, timeouts, 429 and 5xx are
 * retried after 2, 5 and 15 seconds; other 4xx fail at once. Returns the
 * outcome for the caller's log instead of throwing.
 */
export async function sendTelegram(
  token: string,
  chat: string,
  message: { text: string; entities: TextLink[] },
  deps: TelegramDeps,
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  // The URL holds the token; make sure neither it nor the chat id is logged,
  // whatever a failure message contains.
  const redact = (text: string) =>
    text.replaceAll(token, '<token>').replaceAll(chat, '<chat>')
  const body = JSON.stringify({ chat_id: chat, ...message })
  const max = BACKOFF.length + 1
  let error = ''
  for (let attempt = 1; attempt <= max; attempt++) {
    let wait = BACKOFF[attempt - 1] ?? 0
    let retry = true
    try {
      const response = await deps.fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(deps.timeout ?? ATTEMPT_TIMEOUT),
        },
      )
      if (response.ok) return { ok: true, attempts: attempt }
      const data = (await response.json().catch(() => ({}))) as {
        description?: string
        parameters?: { retry_after?: number }
      }
      error = `HTTP ${response.status} description=${data.description ?? 'none'}`
      const retryAfter = data.parameters?.retry_after
      if (response.status === 429 && typeof retryAfter === 'number')
        wait = Math.min(retryAfter * 1000, MAX_RETRY_AFTER)
      retry = response.status === 429 || response.status >= 500
    } catch (caught) {
      error = describeError(caught)
    }
    error = redact(error)
    deps.log(`attempt ${attempt}/${max} failed: ${error}`)
    if (!retry || attempt === max)
      return { ok: false, attempts: attempt, error }
    await deps.sleep(wait)
  }
  return { ok: false, attempts: max, error }
}

/** Message the owner through the service's own bot, when configured. */
async function notify(
  dir: string,
  repository: string,
  text: string,
  log?: WriteStream,
): Promise<void> {
  let env: Record<string, string | undefined> = {}
  try {
    env = parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'))
  } catch {}
  const token = env.TELEGRAM_BOT_TOKEN
  const chat = env.DEPLOY_NOTIFY_CHAT_ID || env.OWNER_TELEGRAM_ID
  if (!token || !chat) return
  const result = await sendTelegram(
    token,
    chat,
    // Cut before linking: shortening never moves a link past the end.
    linkCommits(text.slice(0, 4000), repository),
    {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => {
        warn(`deployment notification ${line}`)
      },
    },
  )
  const line = result.ok
    ? 'notification sent'
    : `notification failed after ${result.attempts} attempts: ${result.error}`
  log?.write(`${new Date().toISOString()} ${line}\n`)
}

/**
 * Run deploy.ts as it is on origin/main, from outside the checkout it
 * switches. With `check`, only report what would be deployed.
 */
async function deployLatest(
  dir: string,
  repository: string,
  check = false,
): Promise<void> {
  const logs = path.join(dir, '.local', 'deploy-webhook')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  const log = createWriteStream(
    path.join(logs, `${new Date().toISOString().replaceAll(':', '')}.log`),
    { mode: 0o600 },
  )
  const script = path.join(
    tmpdir(),
    `midden-deploy-${process.pid}-${Date.now()}.ts`,
  )
  try {
    let result = await run('git', ['fetch', '--quiet', 'origin', 'main'], {
      cwd: dir,
      log,
    })
    if (result.code !== 0) throw new Error('git fetch failed')
    result = await run('git', ['show', 'origin/main:scripts/deploy.ts'], {
      cwd: dir,
    })
    if (result.code !== 0) throw new Error('scripts/deploy.ts missing on main')
    writeFileSync(script, result.output, { mode: 0o600 })
    result = await run(
      process.execPath,
      [script, ...(check ? ['--check'] : [])],
      { cwd: dir, env: { ...process.env, MIDDEN_DIR: dir }, log },
    )
    const outcome =
      /^result: (.+)$/m.exec(result.output)?.[1] ?? 'failed: no result'
    log.write(`exit ${result.code}\n`)
    if (check || outcome.startsWith('already')) return
    const tail = result.output.trim().split('\n').slice(-6).join('\n')
    await notify(
      dir,
      repository,
      outcome.startsWith('deployed')
        ? `✅ midden ${outcome}`
        : `❌ midden 部署失败\n${tail}`,
      log,
    )
  } catch (error) {
    log.write(`${(error as Error).message}\n`)
    if (!check)
      await notify(
        dir,
        repository,
        `❌ midden 部署未开始\n${(error as Error).message}`,
        log,
      )
  } finally {
    rmSync(script, { force: true })
    log.end()
  }
}

if (import.meta.main) {
  // The deployment host reaches api.telegram.org over IPv4 only; its IPv6
  // route fails. Resolve A records first so a connect never starts on the
  // broken path. Only the order changes, so an IPv6-only host still works,
  // and it needs no per-request dispatcher.
  setDefaultResultOrder('ipv4first')
  // As deploy.ts's deploymentDir; this file runs alone, so it cannot import
  // it. The installer sets MIDDEN_DIR anyway.
  const dir = path.resolve(
    process.env.MIDDEN_DIR ||
      (process.platform === 'linux' && process.getuid?.() === 0
        ? '/opt/midden'
        : path.join(homedir(), 'midden')),
  )
  const secret = readFileSync(
    process.env.DEPLOY_WEBHOOK_SECRET_FILE ||
      path.join(dir, '.local', 'deploy-webhook.secret'),
    'utf8',
  ).trim()
  if (secret.length < 32)
    throw new Error('the webhook secret must have at least 32 characters')
  const port = Number(process.env.DEPLOY_WEBHOOK_PORT || 18090)
  const repository = process.env.DEPLOY_WEBHOOK_REPOSITORY || 'sxzz/midden'
  // DEPLOY_WEBHOOK_CHECK=1 only runs `deploy.ts --check`, for trying it out.
  const check = process.env.DEPLOY_WEBHOOK_CHECK === '1'
  const trigger = createDeployer(() => deployLatest(dir, repository, check))
  createServer(createHandler({ secret, repository, trigger })).listen(
    port,
    '127.0.0.1',
    () => console.info(`deploy webhook listening on 127.0.0.1:${port}${PATH}`),
  )
}
