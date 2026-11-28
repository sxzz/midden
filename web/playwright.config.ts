import { createHash } from 'node:crypto'
import process from 'node:process'
import { defineConfig } from '@playwright/test'

// Each worktree gets its own port derived from its path, so concurrent runs from
// different worktrees never share a server. E2E_PORT overrides it.
const hash = createHash('sha1').update(process.cwd()).digest().readUInt16BE(0)
const port = Number(process.env.E2E_PORT) || 20000 + (hash % 20000)
// Workers inherit this, so specs that need the port (passkey) can read it.
process.env.E2E_PORT = String(port)
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  // The suite outgrew 5 minutes on CI's runners (311 of 319 by then); a
  // local run stays capped, since the devbox shares its CPU.
  globalTimeout: (process.env.CI ? 10 : 5) * 60 * 1000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    // Run Vite directly: pnpm can exit before its child and leave teardown hanging.
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/`,
    // Reusing is opt-in: a server already on the port may belong to another worktree.
    reuseExistingServer: !!process.env.E2E_REUSE_SERVER,
  },
})
