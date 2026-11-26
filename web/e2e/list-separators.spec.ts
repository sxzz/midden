import process from 'node:process'
import { expect, test } from './test'

const id = '22222222-2222-4222-8222-222222222222'
const post = {
  id,
  url: 'https://x.com/synthetic/status/2',
  external_id: '2',
  provider_id: 'x',
  revision_id: 'r',
  text: '一条帖子',
  text_kind: 'plain',
  adapter_version: '1',
  author_name: '作者',
  warnings: [],
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  created_at: '2026-09-29T10:00:00Z',
  storage_bytes: 1000,
  assets: [],
  graph: {
    root: 'post',
    relations: [],
    entities: [
      {
        key: 'post',
        type: 'x.post',
        external_id: '2',
        data: {},
        resource_indices: [],
      },
    ],
  },
}

/** Grouped lists draw hairlines only between rows: a first row that paints a
    separator at its top edge reads as a stray line above the card. */
const firstRowsWithSeparator = () =>
  [...document.querySelectorAll('.section-body')].flatMap((body) => {
    const first = body.firstElementChild
    if (!first) return []
    const atTop = (pseudo: '::before' | '::after') => {
      const style = getComputedStyle(first, pseudo)
      return style.content !== 'none' && style.top === '0px'
    }
    return atTop('::before') || atTop('::after')
      ? [first.className || first.tagName]
      : []
  })

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`first row of a section has no top separator (${scheme}, ${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.route('https://telegram.org/**', (r) =>
        r.fulfill({ body: '' }),
      )
      await page.route('**/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname
        if (path === '/v1/session') return r.fulfill({ json: {} })
        if (path === '/v1/usage') return r.fulfill({ json: { used_bytes: 0 } })
        if (path === '/v1/collections')
          return r.fulfill({ json: { items: [post] } })
        if (path === `/v1/collections/${id}`) return r.fulfill({ json: post })
        if (path.endsWith('/availability'))
          return r.fulfill({ json: { available: true } })
        if (path === '/v1/shares') return r.fulfill({ json: [] })
        if (path.endsWith('/annotation'))
          return r.fulfill({ json: { tags: [], note: '' } })
        if (path === '/v1/tags') return r.fulfill({ json: [] })
        if (path.endsWith('/history')) return r.fulfill({ json: { items: [] } })
        if (path === '/v1/folders') return r.fulfill({ json: [] })
        return r.fulfill({ json: {} })
      })
      await page.goto(`/app/collection/${id}`)
      const toggle = page.getByRole('button', { name: /我的整理/ })
      await expect(toggle).toBeVisible()
      await toggle.scrollIntoViewIfNeeded()
      if (process.env.SHOTS)
        await page.screenshot({
          path: `${process.env.SHOTS}-${scheme}-${width}.png`,
        })
      expect(await page.evaluate(firstRowsWithSeparator)).toEqual([])
      await toggle.click()
      await expect(page.getByLabel('备注')).toBeVisible()
      expect(await page.evaluate(firstRowsWithSeparator)).toEqual([])
    })
  }
}
