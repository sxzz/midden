import process from 'node:process'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'e2e',
  globalTimeout: 5 * 60 * 1000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    // Run Vite directly: pnpm can exit before its child and leave teardown hanging.
    command:
      'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/app/',
    reuseExistingServer: !process.env.CI,
  },
})
