import { test } from './test'

// The shared fixture fails a test whose page threw, even when every assertion
// of the test passed; this one is expected to fail for that alone.
test.fail('an uncaught error in the page fails the test', async ({ page }) => {
  await page.route('**/v1/**', (route) =>
    route.fulfill({ json: { items: [] } }),
  )
  await page.goto('/app/')
  const thrown = page.waitForEvent('pageerror')
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('uncaught')
    }, 0)
  })
  await thrown
})
