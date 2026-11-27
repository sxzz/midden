import { expect, test } from './test'

// A Japanese post and an account whose bio is in Chinese: each piece of
// archived text says its language, and the app's own words stay Chinese.
const post = {
  id: '11111111-1111-4111-8111-111111111111',
  url: 'https://x.com/a/status/1',
  external_id: '1',
  provider_id: 'x',
  text: '今日は猫の日です。一日中ずっと寝ていました',
  text_kind: 'text',
  adapter_version: '1',
  warnings: [],
  lang: 'ja',
  author_name: 'Neko',
  observed_at: '2026-11-20T00:00:00Z',
  created_at: '2026-11-20T00:00:00Z',
  saved_at: '2026-11-20T00:00:00Z',
  revision_id: 'r1',
  assets: [],
  graph: {
    root: 'post',
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
    entities: [
      { key: 'post', type: 'x.post', external_id: '1', data: {} },
      {
        key: 'author',
        type: 'x.profile',
        external_id: '7',
        data: { name: 'ねこ', username: 'neko' },
        saved_collection_id: '33333333-3333-4333-8333-333333333333',
        saved_lang: 'ja',
      },
    ],
  },
}
const profile = {
  ...post,
  id: '22222222-2222-4222-8222-222222222222',
  url: 'https://x.com/ming',
  external_id: '8',
  text: 'Ming',
  lang: 'zh-Hans',
  author_name: '小明',
  graph: {
    root: 'p',
    relations: [],
    entities: [
      {
        key: 'p',
        type: 'x.profile',
        external_id: '8',
        data: {
          name: '小明',
          username: 'ming',
          metadata: { description: '画画的，偶尔发日常。约稿请私信' },
        },
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === `/v1/collections/${post.id}`) return r.fulfill({ json: post })
    return r.fulfill({
      json:
        path === '/v1/tags'
          ? []
          : path === '/v1/session'
            ? {}
            : { items: path === '/v1/collections' ? [post, profile] : [] },
    })
  })
})

test('a Japanese post and a Chinese bio carry their languages', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  const japanese = page.locator('.preview', { hasText: '今日は猫の日です' })
  await expect(japanese).toHaveAttribute('lang', 'ja')
  // Japanese breaks between phrases; Chinese keeps the browser's default.
  await expect(japanese).toHaveCSS('word-break', 'auto-phrase')
  const bio = page.locator('.preview', { hasText: '画画的' })
  await expect(bio).toHaveAttribute('lang', 'zh-Hans')
  await expect(bio).toHaveCSS('word-break', 'normal')
  await expect(
    page.locator('.name', { hasText: '小明' }).first(),
  ).toHaveAttribute('lang', 'zh-Hans')
  // The post's page: its text, and its author by the author's language.
  await page.goto(`/collection/${post.id}`)
  await expect(page.locator('.body').first()).toHaveAttribute('lang', 'ja')
  await expect(
    page.locator('.author .name', { hasText: 'ねこ' }).first(),
  ).toHaveAttribute('lang', 'ja')
})
