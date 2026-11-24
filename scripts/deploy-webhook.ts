#!/usr/bin/env node
// Receive GitHub webhooks and deploy when the test workflow, which publishes
// the image, succeeds for a push to main. The payload is only a trigger:
// deploy.ts, taken from origin/main at that moment, resolves the release.
// Installed outside the checkout by install-deploy-webhook.ts.
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
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
        console.error('deployment crashed', error)
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

/** Message the owner through the service's own bot, when configured. */
async function notify(
  dir: string,
  repository: string,
  text: string,
): Promise<void> {
  let env: Record<string, string | undefined> = {}
  try {
    env = parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'))
  } catch {}
  const token = env.TELEGRAM_BOT_TOKEN
  const chat = env.DEPLOY_NOTIFY_CHAT_ID || env.OWNER_TELEGRAM_ID
  if (!token || !chat) return
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          // Cut before linking: shortening never moves a link past the end.
          ...linkCommits(text.slice(0, 4000), repository),
        }),
      },
    )
    if (!response.ok)
      console.error(`deployment notification failed: HTTP ${response.status}`)
  } catch (error) {
    console.error(`deployment notification failed: ${(error as Error).message}`)
  }
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
    )
  } catch (error) {
    log.write(`${(error as Error).message}\n`)
    if (!check)
      await notify(
        dir,
        repository,
        `❌ midden 部署未开始\n${(error as Error).message}`,
      )
  } finally {
    rmSync(script, { force: true })
    log.end()
  }
}

if (import.meta.main) {
  const dir = path.resolve(
    process.env.MIDDEN_DIR || path.join(homedir(), 'midden'),
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
