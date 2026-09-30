import { expect, test } from '@playwright/test'

const id = '22222222-2222-4222-8222-222222222222'
const image = (n: number, sensitive: boolean) => ({
  id: `photo-${n}`,
  state: 'ready',
  mime: 'image/png',
  sensitive,
  alt_text: `图 ${n}`,
})
const collection = (assets: ReturnType<typeof image>[]) => ({
  id,
  url: 'https://example.test/photo',
  text: '敏感媒体测试',
  author_name: '敏感测试',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  warnings: [],
  assets,
})

async function serve(page: import('@playwright/test').Page, assets: unknown[]) {
  const item = collection(assets as ReturnType<typeof image>[])
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/'))
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#456"/></svg>',
      })
    const body =
      path === '/v1/session'
        ? {}
        : path.endsWith('/availability')
          ? { available: true }
          : path.endsWith('/revisions')
            ? { items: [{ id: 'r1', created_at: item.observed_at }] }
            : path === `/v1/collections/${id}`
              ? item
              : path === '/v1/collections/authors'
                ? { items: [] }
                : path === '/v1/usage'
                  ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
                  : { items: [item] }
    return r.fulfill({ json: body })
  })
  await page.goto('/app/')
}

/** The group's own veil, distinct from a single resource's veil in a mixed group. */
const groupVeil = (page: import('@playwright/test').Page) =>
  page.locator('.group-veil')

test('a wholly sensitive group is covered once in the list and the detail', async ({
  page,
}) => {
  await serve(page, [image(1, true), image(2, true), image(3, true)])
  // The list row keeps one veil over the whole thumbnail strip.
  await expect(groupVeil(page)).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: '敏感内容，点按显示' }),
  ).toHaveCount(1)
  // Nothing beneath the veil may be reached by keyboard: tabbing from the row
  // heading lands on the veil itself, never on a covered thumbnail.
  await expect(page.locator('.thumbs')).toHaveAttribute('inert', '')
  await page.locator('.row .head').focus()
  await page.keyboard.press('Tab')
  await expect(groupVeil(page)).toBeFocused()
  await groupVeil(page).click()
  // Revealing must not open the viewer, nor navigate into the collection.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/$/)
  await expect(groupVeil(page)).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Entering the viewer carries the whole group, sensitive resources included.
  await expect(dialog.getByText('1 / 3')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭图片' }).click()

  await page.getByRole('button', { name: /敏感测试/ }).click()
  await expect(groupVeil(page)).toHaveCount(1)
  await groupVeil(page).focus()
  await expect(groupVeil(page)).toBeFocused()
  await groupVeil(page).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  await expect(page.getByRole('dialog').getByText('1 / 3')).toBeVisible()
})

test('a mixed group keeps per-resource reveal and a two-step open', async ({
  page,
}) => {
  await serve(page, [image(1, true), image(2, false)])
  await expect(groupVeil(page)).toHaveCount(0)
  await page.getByRole('button', { name: /敏感测试/ }).click()
  const sensitive = page.getByRole('button', { name: '敏感内容，点按显示' })
  await expect(sensitive).toHaveCount(1)
  await sensitive.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(sensitive).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  await expect(page.getByRole('dialog').getByText('1 / 2')).toBeVisible()
})

test('showing sensitive media globally covers the group again when turned off', async ({
  page,
}) => {
  await serve(page, [image(1, true), image(2, true)])
  const toggle = page.getByRole('button', { name: '显示敏感内容' })
  await toggle.click()
  await expect(groupVeil(page)).toHaveCount(0)
  await toggle.click()
  await expect(groupVeil(page)).toHaveCount(1)
  await groupVeil(page).click()
  await expect(groupVeil(page)).toHaveCount(0)
  await toggle.click()
  await toggle.click()
  await expect(groupVeil(page)).toHaveCount(1)
})

test('sensitive video thumbnails blur until revealed', async ({ page }) => {
  await serve(
    page,
    [1, 2, 3].map((n) => ({ ...image(n, true), mime: 'video/mp4' })),
  )
  const videos = page.locator('.thumbs video')
  await expect(videos).toHaveCount(3)
  for (const video of await videos.all())
    await expect(video).toHaveCSS('filter', 'blur(8px)')
  await expect(groupVeil(page).locator('svg')).toBeVisible()
  await expect(groupVeil(page)).toHaveText('')
  await groupVeil(page).click()
  for (const video of await videos.all())
    await expect(video).toHaveCSS('filter', 'none')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
