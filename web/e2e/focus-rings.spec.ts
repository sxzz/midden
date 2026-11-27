import { mockDesktop } from './desktop-mock'
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
