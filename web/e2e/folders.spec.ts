import { expect, test } from './test'

// A folder holds posts and accounts alike: the tab is the reader's choice,
// never part of its filter, and updating it covers what the server expands.

const folderId = '00000000-0000-7000-8000-0000000000c1'
const author = {
  key: 'profile',
  type: 'x.profile',
  external_id: '100',
  data: { name: '猫咪账号', username: 'cat' },
}
const profile = {
  id: '77777777-7777-4777-8777-777777777777',
  url: 'https://x.com/cat',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'r1',
  author_name: '猫咪账号',
  text: '',
  assets: [],
  graph: { root: 'profile', relations: [], entities: [author] },
}
const post = {
  id: '55555555-5555-4555-8555-555555555555',
  url: 'https://x.com/cat/status/1',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-05T08:00:00Z',
  revision_id: 'r2',
  author_name: '猫咪账号',
  text: '一只猫',
  assets: [],
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '1', data: {} },
      author,
    ],
    relations: [{ source: 'post', target: 'profile', type: 'authored_by' }],
  },
}
const folder = {
  id: folderId,
  name: '猫',
  filter: 'q=cat',
  count: 2,
  types: { 'x.post': 1, 'x.profile': 1 },
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
}

test('a folder shows posts and accounts in tabs, and updates as expanded', async ({
  page,
}) => {
  const lists: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const accounts = (url.searchParams.get('entity_type') ?? '').includes(
      'profile',
    )
    const json = (() => {
      switch (url.pathname) {
        case '/v1/session':
          return {}
        case '/v1/folders':
          return [folder]
        case '/v1/collections':
          lists.push(url.search)
          return { items: [accounts ? profile : post] }
        case '/v1/collections/count':
          return {
            count: 1,
            types: accounts ? { 'x.profile': 1 } : { 'x.post': 1 },
          }
        case '/v1/updates/preview':
          // The server leaves out posts there only through an account.
          return { posts: 1, profiles: 1, listable: 1, name: '猫' }
        case '/v1/usage':
          return { used_bytes: 0 }
        default:
          return url.pathname.endsWith('s') ? [] : { items: [] }
      }
    })()
    return route.fulfill({ json })
  })
  await page.goto(`/folder/${folderId}`)
  const tabs = page.getByRole('tablist', { name: '类型' })
  await expect(tabs.getByRole('tab', { name: '帖子' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByText('一只猫')).toBeVisible()

  await tabs.getByRole('tab', { name: '账号' }).click()
  await expect(page).toHaveURL(/tab=profile/)
  await expect(page.getByText('猫咪账号').first()).toBeVisible()
  expect(lists.at(-1)).toContain('q=cat')
  // Another tab is not another filter.
  await expect(page.getByText('筛选条件已修改')).toHaveCount(0)

  await page.getByRole('button', { name: '管理收藏夹' }).click()
  await page.getByRole('menuitem', { name: '更新收藏夹' }).click()
  await expect(
    page.getByRole('dialog', { name: '更新 1 个账号、1 条帖子' }),
  ).toBeVisible()
})
