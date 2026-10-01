import { expect, test } from '@playwright/test'

const postId = '11111111-1111-4111-8111-111111111111'
const profileId = '22222222-2222-4222-8222-222222222222'
const mentionedId = '33333333-3333-4333-8333-333333333333'
const base = {
  url: 'https://example.test/item',
  observed_at: '2026-10-01T00:00:00Z',
  revision_id: 'r1',
  assets: [],
}
const author = {
  key: 'author',
  type: 'x.profile',
  external_id: '100',
  saved_collection_id: profileId,
  data: { username: 'author' },
}
const mention = {
  key: 'mention',
  type: 'x.profile',
  external_id: '200',
  saved_collection_id: mentionedId,
  data: { username: 'friend' },
}
const post = {
  ...base,
  id: postId,
  text: '合成帖子',
  author_name: '合成作者',
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '300', data: {} },
      author,
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
}
const profile = {
  ...base,
  id: profileId,
  text: '简介 @friend',
  author_name: '合成作者',
  graph: { root: 'author', entities: [author, mention], relations: [] },
}
const mentioned = {
  ...base,
  id: mentionedId,
  text: '朋友简介',
  author_name: '合成朋友',
  graph: { root: 'mention', entities: [mention], relations: [] },
}

for (const deep of [false, true]) {
  test(`returns through nested details ${deep ? 'from a deep link then home' : 'to the filtered list'}`, async ({
    page,
  }) => {
    await page.route('https://telegram.org/**', (route) =>
      route.fulfill({ body: '' }),
    )
    await page.route('**/v1/**', (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname
      let json: unknown
      if (path === '/v1/collections')
        json = { items: url.searchParams.has('related_to') ? [] : [post] }
      else if (path.endsWith('/revisions')) json = { items: [] }
      else if (path.endsWith('/availability')) json = { available: true }
      else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
      else if (path === '/v1/tags') json = []
      else
        json =
          [post, profile, mentioned].find(
            (item) => path === `/v1/collections/${item.id}`,
          ) || {}
      return route.fulfill({ json })
    })
    await page.goto(deep ? `/app/#/collection/${postId}` : '/app/#/?q=fixture')
    if (!deep) await page.locator('.row .head').click()
    await page.locator('.post .profile-link').click()
    await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
    await page.locator('.post .mention').click()
    await expect(page).toHaveURL(new RegExp(`/collection/${mentionedId}$`))
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/collection/${postId}$`))
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(deep ? /#\/$/ : /#\/\?q=fixture$/)
    await expect(page.locator('h1')).toHaveText('我的收藏')
  })
}
