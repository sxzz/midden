import { expect, test } from './test'

// A phone: touch input and a coarse pointer, as iOS reports.
test.use({ hasTouch: true, isMobile: true })

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) =>
    r.fulfill({ json: { items: [], count: 0, types: {} } }),
  )
})

test('fields are at least 16px on a touch screen, so focusing one never zooms', async ({
  page,
}) => {
  const smallest = () =>
    page
      .locator('input, textarea, select')
      .evaluateAll((fields) =>
        fields
          .filter(
            (field) =>
              !['checkbox', 'radio', 'range', 'hidden'].includes(
                (field as HTMLInputElement).type,
              ),
          )
          .map((field) =>
            Number(getComputedStyle(field).fontSize.replace('px', '')),
          ),
      )
  await page.goto('/app/')
  await page.getByRole('button', { name: '筛选' }).click()
  const library = await smallest()
  expect(library.length).toBeGreaterThan(1)
  expect(Math.min(...library)).toBeGreaterThanOrEqual(16)
  await page.goto('/app/captures')
  await expect(page.getByLabel('链接', { exact: true })).toBeVisible()
  const captures = await smallest()
  expect(captures.length).toBeGreaterThan(0)
  expect(Math.min(...captures)).toBeGreaterThanOrEqual(16)
  // Focusing a field leaves the page at its own scale.
  await page.getByLabel('链接', { exact: true }).focus()
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
})

test('a double tap is not a zoom', async ({ page }) => {
  await page.goto('/app/')
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).touchAction,
    ),
  ).toBe('manipulation')
})
