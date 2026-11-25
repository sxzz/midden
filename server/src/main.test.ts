import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
let child: ChildProcess | undefined
beforeEach(async () => {
  telegram = await new FakeTelegram().start()
  dir = mkdtempSync(path.join(tmpdir(), 'midden-main-'))
})
afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  child = undefined
  await telegram.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** The server as the container runs it, its log lines collected. */
async function startServer() {
  const port = await freePort()
  const lines: string[] = []
  child = spawn(process.execPath, [MAIN], {
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
      TELEGRAM_API_ROOT: telegram.apiRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
