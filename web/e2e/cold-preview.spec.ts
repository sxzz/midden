import { expect, test } from '@playwright/test'

test('first list preview fits the image after dimensions arrive during opening', async ({
  page,
}) => {
  const { promise: ready, resolve: release } = Promise.withResolvers<void>()
  const collection = {
    id: '11111111-1111-4111-8111-111111111111',
    url: 'https://example.test/post',
    text: 'Cold image',
    author_name: 'Author',
    observed_at: '2026-09-30T00:00:00Z',
    visibility: 'public',
    revision_id: 'r1',
    assets: [
      { id: 'cold', state: 'ready', mime: 'image/svg+xml', sensitive: false },
    ],
  }
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/')) {
      await ready
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1500"><path fill="#397582" d="M0 0h500v1500H0z"/></svg>',
      })
    }
    return r.fulfill({
      json:
        path === '/v1/tags'
          ? []
          : path === '/v1/session'
            ? {}
            : { items: [collection] },
    })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: '放大图片', exact: true }).click()
  const image = page
    .getByRole('dialog')
    .locator('.pswp__item[aria-hidden="false"] img.pswp__img')
  // No thumbnail dimensions are known yet, so the slide spans the viewport
  // and the picture is contained instead of stretched to a guessed ratio.
  await expect(image).toHaveCSS('object-fit', 'contain')
  await expect
    .poll(async () => {
      const box = await image.boundingBox()
      return [Math.round(box?.width || 0), Math.round(box?.height || 0)]
    })
    .toEqual([390, 844])
  release()
  await expect
    .poll(async () => {
      const box = await image.boundingBox()
      return Math.round(box?.height || 0)
    })
    .toBe(844)
  await expect
    .poll(async () => {
      const box = await image.boundingBox()
      return Math.round(box?.width || 0)
    })
    .toBe(281)
  await page.getByRole('button', { name: '关闭图片' }).click()
  await page.getByRole('button', { name: '放大图片', exact: true }).click()
  await expect
    .poll(async () => Math.round((await image.boundingBox())?.height || 0))
    .toBe(844)
})
