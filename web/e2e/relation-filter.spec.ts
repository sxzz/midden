import { expect, test } from './test'

const OWNER = 'x/x.profile/100'
const FRIEND = 'x/x.profile/200'
const accounts = [
  {
    id: OWNER,
    name: '我',
    username: 'owner',
    own: true,
    following: { complete_at: '2026-11-20T04:00:00.000Z' },
    followers: {},
  },
  {
    id: FRIEND,
    name: '朋友',
    username: 'friend',
    following: {},
    followers: {},
  },
]

test('the 关系 filter picks an account, then whose follows to list', async ({
  page,
}) => {
  const queries: URLSearchParams[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/tags' || url.pathname === '/v1/folders')
      return r.fulfill({ json: [] })
    if (url.pathname === '/v1/collections/perspectives') {
      const key = url.searchParams.get('rel_of')
      const q = url.searchParams.get('q') ?? ''
      return r.fulfill({
        json: {
          items: accounts.filter((a) =>
            key ? a.id === key : a.username.includes(q),
          ),
        },
      })
    }
    if (url.pathname === '/v1/collections') queries.push(url.searchParams)
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: /^筛选/ }).click()
  const picker = page.locator('summary[aria-label="关系"]')
  await expect(picker).toContainText('全部')
  await expect(page.getByRole('radiogroup', { name: '关系方向' })).toHaveCount(
    0,
  )
  await picker.click()
  const options = page
    .getByRole('listbox', { name: '关系' })
    .getByRole('option')
  // The owner's own account comes first; each reads by name and handle.
  await expect(options).toHaveText(['我 @owner', '朋友 @friend'])
  await options.nth(1).click()
  const query = () => {
    const q = queries.at(-1)
    return q && [q.get('rel_of'), q.get('rel')]
  }
  await expect.poll(query).toEqual([FRIEND, 'following'])
  await expect(page.locator('.filter-summary')).toHaveText('@friend 关注的')
  const mode = page.getByRole('radiogroup', { name: '关系方向' })
  await expect(mode.locator('label')).toHaveText([
    '他关注的',
    '关注他的',
    '互关',
  ])
  // Unread lists are only inferred from others' lists, and it says so.
  await expect(page.locator('.relation .note')).toHaveText('关注名单未抓取')

  await mode.getByText('互关').click()
  await expect.poll(query).toEqual([FRIEND, 'mutual'])
  await expect(page.locator('.filter-summary')).toHaveText('@friend 互关')
  await expect(page.locator('.relation .note')).toHaveText(
    '关注名单未抓取 · 粉丝名单未抓取',
  )
  await page.screenshot({ path: 'test-results/relation-filter.png' })

  // The address keeps it; a reload reads the account by its handle again.
  await expect(page).toHaveURL(/rel=mutual/)
  await page.reload()
  await expect(page.locator('.filter-summary')).toHaveText('@friend 互关')

  await page.getByRole('button', { name: '清除' }).click()
  await expect.poll(query).toEqual([null, null])
})
