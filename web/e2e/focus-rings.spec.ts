import { mockDesktop, POST_ID } from './desktop-mock'
import { expect, test, type Locator } from './test'

/**
 * The box a control's focus ring covers (its outline past its border box),
 * and the box of the nearest ancestor that clips it: a scroller, or
 * anything else with overflow other than visible.
 */
function ringAndClip(control: Locator) {
  return control.evaluate((el) => {
    const px = (value: string) => Number(value.replace('px', '')) || 0
    const style = getComputedStyle(el)
    const width = style.outlineStyle === 'none' ? 0 : px(style.outlineWidth)
    const reach = width ? width + px(style.outlineOffset) : 0
    const box = el.getBoundingClientRect()
    const ring = {
      left: box.left - reach,
      top: box.top - reach,
      right: box.right + reach,
      bottom: box.bottom + reach,
    }
    let clip = el.parentElement
    while (clip) {
      const s = getComputedStyle(clip)
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') break
      clip = clip.parentElement
    }
    const outer = clip!.getBoundingClientRect()
    const left = outer.left + clip!.clientLeft
    const top = outer.top + clip!.clientTop
    return {
      width,
      ring,
      clip: {
        left,
        top,
        right: left + clip!.clientWidth,
        bottom: top + clip!.clientHeight,
      },
    }
  })
}

test.describe('in a dialog', () => {
  test.use({ viewport: { width: 1000, height: 800 } })

  for (const scheme of ['light', 'dark'] as const) {
    test(`a field’s ring is not cut by the scrolling content (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await mockDesktop(page)
      await page.goto('/app/settings/admin/origins')
      await page.getByRole('button', { name: '添加域名' }).click()
      const dialog = page.getByRole('dialog', { name: '添加域名' })
      const field = dialog.getByRole('textbox', { name: '地址' })
      await expect(field).toBeFocused()
      const { width, ring, clip } = await ringAndClip(field)
      expect(width).toBeGreaterThan(0)
      expect(ring.top).toBeGreaterThanOrEqual(clip.top)
      expect(ring.left).toBeGreaterThanOrEqual(clip.left)
      expect(ring.right).toBeLessThanOrEqual(clip.right)
      expect(ring.bottom).toBeLessThanOrEqual(clip.bottom)
    })
  }
})

const px = (value: string) => Number(value.replace('px', '')) || 0

/** A control's ring: its outline's box, its corners, and whether it has one. */
function ringOf(control: Locator) {
  return control.evaluate((el) => {
    const px = (value: string) => Number(value.replace('px', '')) || 0
    const style = getComputedStyle(el)
    const width = style.outlineStyle === 'none' ? 0 : px(style.outlineWidth)
    const reach = width ? width + px(style.outlineOffset) : 0
    const box = el.getBoundingClientRect()
    return {
      width,
      left: box.left - reach,
      top: box.top - reach,
      right: box.right + reach,
      bottom: box.bottom + reach,
      radius: style.borderTopLeftRadius,
    }
  })
}

test.describe('a composite field', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  for (const scheme of ['light', 'dark'] as const) {
    test(`the new tag’s pill is ringed whole, not its field (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await mockDesktop(page)
      await page.goto(`/app/collection/${POST_ID}`)
      await page.getByRole('button', { name: /我的整理/ }).click()
      const field = page.getByRole('textbox', { name: '新标签名称' })
      await field.focus()
      const pill = field.locator('xpath=..')
      const box = (await pill.boundingBox())!
      expect((await ringOf(field)).width).toBe(0)
      const ring = await ringOf(pill)
      expect(ring.width).toBeGreaterThan(0)
      // Round the pill's edge, as round as the pill.
      expect(ring.left).toBeLessThan(box.x)
      expect(ring.right).toBeGreaterThan(box.x + box.width)
      expect(ring.top).toBeLessThan(box.y)
      expect(ring.bottom).toBeGreaterThan(box.y + box.height)
      expect(px(ring.radius)).toBeGreaterThanOrEqual(box.height / 2)
      // Gone when the field lets go.
      await field.blur()
      expect((await ringOf(pill)).width).toBe(0)
    })
  }

  test('the search box rings as one, its buttons from the keyboard only', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    const field = page.locator('main .query .field')
    await field.focus()
    const bar = field.locator('xpath=..')
    expect((await ringOf(field)).width).toBe(0)
    expect((await ringOf(bar)).width).toBeGreaterThan(0)
    // A click on 搜索 rings neither it nor the box.
    const submit = bar.getByRole('button', { name: '搜索' })
    await submit.click()
    expect((await ringOf(bar)).width).toBe(0)
    expect((await ringOf(submit)).width).toBe(0)
  })
})
