import { expect, test } from '@playwright/test'

test('filter changes apply immediately without collapsing controls', async ({
  page,
}) => {
  const queries: URLSearchParams[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections/authors')
      return r.fulfill({
        json: {
          items: [
            { id: 'x/x.profile/1', name: '作者甲' },
            { id: 'x/x.profile/2', name: '作者乙' },
            { id: 'x/x.profile/3', name: '作者丙' },
          ],
        },
      })
    if (url.pathname === '/v1/collections') queries.push(url.searchParams)
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/')
  const panel = page.getByRole('button', { name: /^筛选/ })
  await panel.click()
  await expect(page.getByRole('button', { name: '应用筛选' })).toHaveCount(0)
  await page.locator('summary[aria-label="作者"]').click()
  const list = page.getByRole('listbox', { name: '作者', exact: true })
  await list.getByRole('option', { name: '作者甲' }).click()
  await expect
    .poll(() => queries.at(-1)?.getAll('author'))
    .toEqual(['x/x.profile/1'])
  await expect(panel).toHaveAttribute('aria-expanded', 'true')
  await expect(list).toBeVisible()
  await list.getByRole('option', { name: '作者乙' }).click()
  await expect
    .poll(() => queries.at(-1)?.getAll('author'))
    .toEqual(['x/x.profile/1', 'x/x.profile/2'])
  await expect(list).toBeVisible()
  await page.screenshot({
    path: 'test-results/inline-filter-tags.png',
    fullPage: true,
  })
  const tags = await list.getByRole('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      y: node.getBoundingClientRect().y,
      x: node.getBoundingClientRect().x,
    })),
  )
  expect(tags[0]!.y).toBe(tags[1]!.y)
  expect(tags[1]!.x).toBeGreaterThan(tags[0]!.x)
  // The other tab is its own list with its own filters; coming back finds
  // this one as it was left, without asking the server again.
  await page.getByRole('tab', { name: '账号' }).click()
  await expect
    .poll(() => queries.at(-1)?.get('entity_type'))
    .toBe('x.profile,instagram.profile')
  expect(queries.at(-1)?.getAll('author')).toEqual([])
  await expect(panel).toHaveAttribute('aria-expanded', 'false')
  const requests = queries.length
  await page.getByRole('tab', { name: '帖子' }).click()
  await expect(panel).toHaveAttribute('aria-expanded', 'true')
  await expect(list.getByRole('option', { name: '作者乙' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(queries.length).toBe(requests)
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => queries.at(-1)?.getAll('author')).toEqual([])
  await expect(page).toHaveURL(/#\/$/)
  await expect(panel).toHaveAttribute('aria-expanded', 'true')
  await expect(list).toBeVisible()
  await expect(list.getByRole('option', { name: '作者甲' })).toHaveAttribute(
    'aria-selected',
    'false',
  )
  await page.goBack()
  await expect(list.getByRole('option', { name: '作者甲' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})
