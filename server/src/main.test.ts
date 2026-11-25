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
