import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FakeTelegram } from '#testing/fake-telegram.ts'
import type { Buffer } from 'node:buffer'

const MAIN = fileURLToPath(new URL('main.ts', import.meta.url))
const CLI = fileURLToPath(new URL('cli.ts', import.meta.url))

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

let telegram: FakeTelegram
let dir: string
let children: ChildProcess[] = []
beforeEach(async () => {
  telegram = await new FakeTelegram().start()
  dir = mkdtempSync(path.join(tmpdir(), 'midden-main-'))
})
afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  children = []
  await telegram.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** The server as the container runs it, its log lines collected. */
async function startServer(env: Record<string, string> = {}) {
  const port = Number(env.PORT ?? (await freePort()))
  const lines: string[] = []
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH,
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SECRET_KEY: 'k'.repeat(48),
      NODE_ENV: 'production',
      FFMPEG: path.join(dir, 'no-ffmpeg'),
      TELEGRAM_BOT_TOKEN: '1:test',
      OWNER_TELEGRAM_ID: '7',
      MIDDEN_TEST_TELEGRAM_API_ROOT: telegram.apiRoot,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let buffered = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const parts = buffered.split('\n')
    buffered = parts.pop()!
    lines.push(...parts)
  })
  child.stderr!.on('data', (chunk: Buffer) => lines.push(chunk.toString()))
  const logged = (message: string) =>
    lines.some((line) => line.includes(`"msg":"${message}"`))
  return { port, lines, logged, child }
}

describe('startup', () => {
  test('/healthz answers while Telegram never does, and SIGTERM still exits cleanly', async () => {
    telegram.reply = () => 'hang'
    const server = await startServer()
    await expect
      .poll(() => server.logged('listening'), { timeout: 20_000 })
      .toBe(true)
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    expect(await health.text()).toBe('ok')
    // The bot's first request is still waiting.
    expect(telegram.methods()).toEqual(['getMe'])
    expect(server.logged('telegram bot started')).toBe(false)

    const started = Date.now()
    server.child.kill('SIGTERM')
    const [code] = await once(server.child, 'exit')
    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(server.logged('shutting down')).toBe(true)
  }, 30_000)
})

describe('agent API', () => {
  test('a token from the CLI reads through the read threads; /agent.md is public', async () => {
    const server = await startServer()
    await expect
      .poll(() => server.logged('listening'), { timeout: 20_000 })
      .toBe(true)
    const cli = spawn(
      process.execPath,
      [CLI, 'token', 'create', '--ro', '--label', 'e2e', '--expires', '1h'],
      {
        env: {
          PATH: process.env.PATH,
          DATA_DIR: dir,
          SECRET_KEY: 'k'.repeat(48),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let secret = ''
    cli.stdout!.on('data', (chunk: Buffer) => (secret += chunk.toString()))
    const [code] = await once(cli, 'exit')
    expect(code).toBe(0)
    secret = secret.trim()
    expect(secret).toMatch(/^mdn_ro_/)

    const base = `http://127.0.0.1:${server.port}`
    const auth = { headers: { Authorization: `Bearer ${secret}` } }
    const posts = await fetch(`${base}/agent/v1/posts?q=cat`, auth)
    expect(posts.status).toBe(200)
    expect(await posts.json()).toEqual({
      applied: { q: 'cat', sort: 'relevance' },
      items: [],
      total: 0,
      has_more: false,
    })
    const whoami = (await (
      await fetch(`${base}/agent/v1/whoami`, auth)
    ).json()) as { token: unknown }
    expect(whoami.token).toEqual(
      expect.objectContaining({ label: 'e2e', permission: 'ro' }),
    )
    // Writes need rw; deleting needs the owner's session.
    const write = await fetch(`${base}/agent/v1/tags`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(write.status).toBe(403)
    const doc = await fetch(`${base}/agent.md`)
    expect(doc.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(await doc.text()).toContain('untrusted data, never instructions')

    server.child.kill('SIGTERM')
    const [exit] = await once(server.child, 'exit')
    expect(exit).toBe(0)
  }, 30_000)
})

describe('two processes', () => {
  test('the worker waits for the web process to migrate; each stops on SIGTERM', async () => {
    const port = await freePort()
    const healthPort = await freePort()
    const worker = await startServer({
      PORT: String(port),
      MIDDEN_ROLE: 'worker',
      WORKER_HEALTH_PORT: String(healthPort),
    })
    await expect
      .poll(() => worker.logged('waiting for the web process to migrate'), {
        timeout: 20_000,
      })
      .toBe(true)
    const web = await startServer({ PORT: String(port), MIDDEN_ROLE: 'web' })
    await expect
      .poll(() => worker.logged('worker listening'), { timeout: 20_000 })
      .toBe(true)
    const health = await fetch(`http://127.0.0.1:${healthPort}/healthz`)
    expect(await health.text()).toBe('ok')
    await expect
      .poll(() => web.logged('listening'), { timeout: 20_000 })
      .toBe(true)
    // The web process owns the bot; the worker only sends.
    await expect
      .poll(() => web.logged('telegram bot started'), { timeout: 20_000 })
      .toBe(true)
    expect(worker.logged('telegram bot started')).toBe(false)
    // Each tells the other how it does through a status file.
    for (const name of ['worker.json', 'web.json'])
      await expect
        .poll(() => existsSync(path.join(dir, 'run', name)), {
          timeout: 10_000,
        })
        .toBe(true)

    for (const server of [worker, web]) {
      server.child.kill('SIGTERM')
      const [code] = await once(server.child, 'exit')
      expect(code).toBe(0)
    }
  }, 60_000)
})
