import { test as base, expect, type Page } from '@playwright/test'

export { expect, type Page }

/**
 * Playwright's test, failing any test during which a page threw an uncaught
 * error. Otherwise a mock that lacks a field the app reads breaks the page
 * where no assertion looks, and the test still passes.
 */
export const test = base.extend<{ pageErrors: Error[] }>({
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
