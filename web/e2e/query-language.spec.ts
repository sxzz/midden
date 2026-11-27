import { expect, test, type Page } from './test'

// The owner's search box takes the query language: it says how it reads a
// query and where it cannot, completes terms, and is one list with the
// filter controls. Any query saves as a folder. 刷新 reads a list again in
// place.

const TAG = '0193b6e0-0000-7000-8000-00000000000a'
const CAT = 'x/x.profile/100'
const TWIN = 'x/x.profile/200'
const FOLDER = '00000000-0000-7000-8000-0000000000d1'

function post(i: number) {
  return {
    id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    url: `https://x.com/cat/status/${i}`,
    observed_at: '2026-11-05T08:00:00Z',
    saved_at: '2026-11-05T08:00:00Z',
    revision_id: `r${i}`,
    author_name: '猫咪账号',
    text: `第 ${i} 只猫`,
    assets: [],
    graph: {
      root: 'post',
      entities: [
        { key: 'post', type: 'x.post', external_id: String(i), data: {} },
        {
          key: 'profile',
          type: 'x.profile',
          external_id: '100',
          data: { name: '猫咪账号', username: 'cat' },
        },
      ],
      relations: [{ source: 'post', target: 'profile', type: 'authored_by' }],
    },
  }
}

interface Mock {
  /** The list requests' query strings, in order. */
  lists: URLSearchParams[]
  /** Bodies of the folders written. */
  folders: unknown[]
}

async function mock(page: Page, size = 3): Promise<Mock> {
  const seen: Mock = { lists: [], folders: [] }
  const saved = {
    id: FOLDER,
    name: '链接',
    query: 'domain:a.test',
    filter: null,
    sort: '',
    order: '',
    tz: '',
    count: 1,
    types: { 'x.post': 1 },
    counted_at: '2026-11-05T08:00:00.000Z',
    stale: false,
    created_at: '2026-11-05T08:00:00.000Z',
    updated_at: '2026-11-05T08:00:00.000Z',
  }
  const folders: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (() => {
      switch (url.pathname) {
        case '/v1/session':
          return {}
        case '/v1/folders':
          if (request.method() === 'POST') {
            seen.folders.push(request.postDataJSON())
            folders.push(saved)
            return saved
          }
          return folders
        case '/v1/tags':
          return [{ id: TAG, name: '猫', collections: 2 }]
        case '/v1/collections':
          seen.lists.push(url.searchParams)
          // A tag the archive does not have, as the server answers it.
          if (url.searchParams.get('q')?.includes('tag:nope'))
            return {
              status: 400,
              body: {
                error: 'Unknown tag nope. GET /agent/v1/tags lists them.',
                code: 'query_invalid',
                kind: 'unknown_tag',
                detail: { value: 'nope' },
                position: 0,
              },
            }
          return {
            items: Array.from({ length: size }, (_, i) => post(i + 1)),
          }
        case '/v1/collections/authors':
          return {
            items: [
              { id: CAT, name: '猫咪账号', count: 3, term: '@cat' },
              // No handle names it alone: its key does.
              { id: TWIN, name: '双胞胎', count: 1 },
            ],
          }
        case '/v1/collections/count':
          return { count: size, types: { 'x.post': size } }
        case '/v1/query/suggest':
          return {
            items:
              url.searchParams.get('kind') === 'handle'
                ? [
                    { value: '@alice', label: 'Alice', count: 3 },
                    { value: '@albert', label: 'Albert', count: 1 },
                  ]
                : [],
          }
        case '/v1/usage':
          return { used_bytes: 0 }
        default:
          return url.pathname.endsWith('s') ? [] : { items: [] }
      }
    })()
    if (json && typeof json === 'object' && 'status' in json)
      return route.fulfill({
        status: (json as { status: number }).status,
        json: (json as { body: unknown }).body,
      })
    return route.fulfill({ json })
  })
  return seen
}

const box = (page: Page) => page.getByRole('combobox', { name: '搜索或筛选' })

test('a query filters the list, and the controls show what they can say', async ({
  page,
}) => {
  const seen = await mock(page)
  await page.goto('/app/')
  await expect(page.getByText('第 1 只猫')).toBeVisible()

  await box(page).fill('has:image #猫 cat')
  // How it reads, before it is run.
  await expect(page.getByText('解析为')).toHaveCount(0)
  await box(page).press('Enter')
  await expect(page).toHaveURL(/media_type=image/)
  await expect.poll(() => seen.lists.at(-1)?.get('media_type')).toBe('image')
  expect(seen.lists.at(-1)?.get('q')).toBe('#猫 cat')
  // The box says the whole query; the control says its part.
  await expect(box(page)).toHaveValue('#猫 cat has:image')
  await page.getByRole('button', { name: '筛选' }).click()
  await expect(page.locator('.filter-summary')).toHaveText('图片 · 自定义')

  // A control's change is a term in the box.
  await page.getByLabel('帖子类型').selectOption('quote')
  await expect(box(page)).toHaveValue('#猫 cat has:image is:quote')
  await expect.poll(() => seen.lists.at(-1)?.get('post_type')).toBe('quote')

  // A term the box takes off is gone from the control.
  await box(page).fill('#猫 cat is:quote tag:猫')
  await box(page).press('Enter')
  await expect(page).toHaveURL(new RegExp(`tag=${TAG}`))
  await expect.poll(() => seen.lists.at(-1)?.get('media_type')).toBeNull()
  await expect(page.locator('.filter-summary')).toHaveText('猫 · 引用 · 自定义')
  // Alternatives across fields stay the query's.
  await box(page).fill('has:image OR is:quote')
  await box(page).press('Enter')
  await expect
    .poll(() => seen.lists.at(-1)?.get('q'))
    .toBe('has:image OR is:quote')
  await expect(page.locator('.filter-summary')).toHaveText('自定义')
})

test('a query it cannot read says why and where, and is not run', async ({
  page,
}) => {
  const seen = await mock(page)
  await page.goto('/app/')
  await expect(page.getByText('第 1 只猫')).toBeVisible()
  const before = seen.lists.length
  await box(page).fill('cat (dog')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('这个 ( 没有闭合')
  await expect(alert.locator('mark')).toHaveText('(')
  await expect(box(page)).toHaveAttribute('aria-invalid', 'true')
  await box(page).press('Enter')
  // The caret goes to the place.
  expect(
    await box(page).evaluate((el: HTMLInputElement) => el.selectionStart),
  ).toBe(4)
  expect(seen.lists.length).toBe(before)

  // What only the server knows, said the same way.
  await box(page).fill('tag:nope')
  await box(page).press('Enter')
  await expect(page.getByText('没有标签「nope」')).toBeVisible()

  // A query read otherwise than written says how.
  await box(page).fill('a  b OR c')
  await expect(page.getByText('解析为')).toContainText('(a b) OR c')

  // The terms, with examples.
  await page.getByRole('button', { name: '查询语法' }).click()
  await expect(page.getByRole('dialog', { name: '查询语法' })).toContainText(
    'from:@alice',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '查询语法' })).toHaveCount(0)
})

test('terms are completed: keys, values and handles the library knows', async ({
  page,
}) => {
  const seen = await mock(page)
  await page.goto('/app/')
  await expect(page.getByText('第 1 只猫')).toBeVisible()
  // The list and its count are in, so nothing rewrites the box meanwhile.
  await expect(page.locator('.total')).toHaveText('3 条')
  await box(page).click()
  await page.keyboard.type('cat ha')
  await expect(box(page)).toHaveValue('cat ha')
  const options = page.getByRole('listbox', { name: '补全' })
  const option = (name: string | RegExp) =>
    options.getByRole('option', { name })
  // Each step waits for the option it takes to be the chosen one.
  await expect(option('has:')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveValue('cat has:')
  await expect(option('image')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(option('video')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveValue('cat has:video ')

  // Handles come from the server, after a pause in typing. Typed on with
  // the keyboard alone: focusing the field again would put the caret at
  // its start when another page of the browser has the focus.
  const answered = page.waitForResponse(
    (r) =>
      r.url().includes('/v1/query/suggest') && r.url().includes('prefix=al'),
  )
  await page.keyboard.type('from:@al')
  await expect(box(page)).toHaveValue('cat has:video from:@al')
  await answered
  await expect(option(/@alice/)).toHaveAttribute('aria-selected', 'true')
  await expect(option(/@albert/)).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(box(page)).toHaveValue('cat has:video from:@alice ')
  // Nothing left to complete: Enter runs it.
  await expect(options).toBeHidden()
  await page.keyboard.press('Enter')
  await expect.poll(() => seen.lists.at(-1)?.get('q')).toBe('cat from:@alice')
  expect(seen.lists.at(-1)?.get('media_type')).toBe('video')
})

test('any query saves as a folder, which opens by its query', async ({
  page,
}) => {
  const seen = await mock(page)
  await page.goto('/app/')
  await box(page).fill('domain:a.test')
  await box(page).press('Enter')
  await expect.poll(() => seen.lists.at(-1)?.get('q')).toBe('domain:a.test')
  await page.getByRole('button', { name: '存为收藏夹' }).click()
  await page.getByPlaceholder('收藏夹名称').fill('链接')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => seen.folders.length).toBe(1)
  expect(seen.folders[0]).toEqual({ name: '链接', filter: 'q=domain%3Aa.test' })
  await expect(page).toHaveURL(new RegExp(`/folder/${FOLDER}`))
  await expect(box(page)).toHaveValue('domain:a.test')
  await expect(page.getByText('筛选条件已修改')).toHaveCount(0)
})

test('刷新 reads the list again with its filters, keeping it and the scroll', async ({
  page,
}) => {
  const seen = await mock(page, 40)
  await page.goto('/app/?media_type=image')
  await expect(page.getByText('第 1 只猫')).toBeVisible()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300)
  const scrolled = await page.evaluate(() => scrollY)
  const before = seen.lists.length
  // Slow, so the turning button and the list kept meanwhile can be seen.
  await page.route('**/v1/collections?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fallback()
  })
  const refresh = page.getByRole('button', { name: '刷新' })
  await refresh.evaluate((el: HTMLElement) => el.click())
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('第 1 只猫')).toBeAttached()
  await expect(refresh).toHaveAttribute('aria-busy', 'false')
  expect(seen.lists.length).toBeGreaterThan(before)
  expect(seen.lists.at(-1)?.get('media_type')).toBe('image')
  expect(seen.lists.at(-1)?.has('cursor')).toBe(false)
  expect(
    Math.abs((await page.evaluate(() => scrollY)) - scrolled),
  ).toBeLessThan(4)
})

test('behind a share the box is a keyword search, and 刷新 is there too', async ({
  page,
}) => {
  const lists: URLSearchParams[] = []
  const base = '/v1/public/cats-share'
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith(base))
      return route.fulfill({ status: 401, json: { error: '需要登录' } })
    const rest = url.pathname.slice(base.length)
    if (rest === '/collections') lists.push(url.searchParams)
    const answers: Record<string, unknown> = {
      '': { target: 'folder', name: '公开收藏夹', posts: 1, profiles: 0 },
      '/collections': { items: [post(1)] },
      '/collections/count': { count: 1, types: { 'x.post': 1 } },
    }
    return route.fulfill({ json: answers[rest] ?? { items: [] } })
  })
  await page.goto('/app/s/cats-share')
  await expect(page.getByText('第 1 只猫')).toBeVisible()
  await expect(box(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查询语法' })).toHaveCount(0)
  const search = page.getByRole('searchbox', { name: '搜索正文或作者' })
  await search.fill('tag:猫 from:@a')
  await search.press('Enter')
  await expect.poll(() => lists.at(-1)?.get('q')).toBe('tag:猫 from:@a')
  const count = lists.length
  await page.getByRole('button', { name: '刷新' }).click()
  await expect.poll(() => lists.length).toBeGreaterThan(count)
  expect(lists.at(-1)?.get('q')).toBe('tag:猫 from:@a')
  expect([...lists.at(-1)!.keys()]).not.toContain('tag')
})

test('an author picked in the controls is @handle in the box, its key in the list', async ({
  page,
}) => {
  const seen = await mock(page)
  await page.goto('/app/')
  await expect(page.getByText('第 1 只猫')).toBeVisible()
  await page.getByRole('button', { name: '筛选' }).click()
  await page.locator('summary[aria-label="作者"]').click()
  const authors = page.getByRole('listbox', { name: '作者' })
  await authors.getByRole('option', { name: /猫咪账号/ }).click()
  await expect.poll(() => seen.lists.at(-1)?.getAll('author')).toEqual([CAT])
  await expect(box(page)).toHaveValue('from:@cat')
  // One with no handle of its own is written by its key.
  await authors.getByRole('option', { name: /双胞胎/ }).click()
  await expect(box(page)).toHaveValue(`(from:@cat OR from:${TWIN})`)
  await expect
    .poll(() => seen.lists.at(-1)?.getAll('author').toSorted())
    .toEqual([CAT, TWIN])
  // Typed back, the handle is the control's again, not the query's.
  await box(page).fill('cat from:@cat')
  await box(page).press('Enter')
  await expect.poll(() => seen.lists.at(-1)?.getAll('author')).toEqual([CAT])
  expect(seen.lists.at(-1)?.get('q')).toBe('cat')
  await expect(box(page)).toHaveValue('cat from:@cat')
})
