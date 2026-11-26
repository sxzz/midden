import process from 'node:process'
import { test as base, expect, type Page } from '@playwright/test'

export { expect, type Page }

/**
 * A Chromium already running, reached over CDP at `E2E_CDP`
 * (`http://localhost:9222`), when Playwright's own cannot start here. Tests
 * get contexts of their own in it, and leave it running. Off unless set.
 */
const CDP = process.env.E2E_CDP

/**
 * Playwright's test, failing any test during which a page threw an uncaught
 * error. Otherwise a mock that lacks a field the app reads breaks the page
 * where no assertion looks, and the test still passes.
 */
export const test = base.extend<{ pageErrors: Error[] }>({
  ...(CDP
    ? {
        browser: [
          async ({ playwright }, use) => {
            const browser = await playwright.chromium.connectOverCDP(CDP)
            await use(browser)
            // Disconnects, closing only the contexts the tests made.
            await browser.close()
          },
          { scope: 'worker' },
        ],
      }
    : {}),
  pageErrors: [
    async ({ context }, use) => {
      const errors: Error[] = []
      const watch = (page: Page) =>
        page.on('pageerror', (error) => errors.push(error))
      context.pages().forEach(watch)
      context.on('page', watch)
      await use(errors)
      expect(
        errors.map((error) => error.stack ?? error.message),
        'uncaught errors in the page',
      ).toEqual([])
    },
    { auto: true },
  ],
})
