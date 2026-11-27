import { expect, test } from './test'

const A = '00000000-0000-7000-8000-00000000000a'
const B = '00000000-0000-7000-8000-00000000000b'

test('tags are wanted, matched together and excluded from the filter panel', async ({
  page,
}) => {
  const queries: URLSearchParams[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/tags')
      return r.fulfill({
        json: [
          { id: A, name: '猫' },
          { id: B, name: '狗' },
        ],
      })
    if (url.pathname === '/v1/collections') queries.push(url.searchParams)
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^筛选/ }).click()
  const chips = page.getByRole('group', { name: '标签筛选' })
  const query = () => {
    const q = queries.at(-1)
    return q && ['tag', 'tag_mode', 'not_tag'].map((key) => q.get(key))
  }

  await chips.getByRole('button', { name: '猫：不限' }).click()
  await chips.getByRole('button', { name: '狗：不限' }).click()
  await expect.poll(query).toEqual([`${A},${B}`, null, null])
  const mode = page.getByRole('radiogroup', { name: '标签匹配方式' })
  await mode.getByText('全部').click()
  await expect.poll(query).toEqual([`${A},${B}`, 'all', null])
  await expect(page.locator('.filter-summary')).toHaveText('猫 且 狗')

  // A second tap excludes the tag: the name alone, struck through in red.
  await chips.getByRole('button', { name: '狗：包含' }).click()
  await expect.poll(query).toEqual([A, null, B])
  const excluded = chips.getByRole('button', { name: '狗：排除' })
  await expect(excluded).toHaveText('狗')
  await expect(excluded).toHaveCSS('text-decoration-line', 'line-through')
  await expect(mode).toHaveCount(0)
  await expect(page.locator('.filter-summary')).toHaveText('猫、非 狗')
  await page.screenshot({ path: 'test-results/tag-filters.png' })

  await chips.getByRole('button', { name: '全部', exact: true }).click()
  await expect.poll(query).toEqual([null, null, null])
})
