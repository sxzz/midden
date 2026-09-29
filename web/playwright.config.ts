import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:5173/app/",
    reuseExistingServer: !process.env.CI,
  },
});
