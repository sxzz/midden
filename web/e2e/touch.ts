import { expect, type Page } from '@playwright/test'

export async function swipeImage(page: Page) {
  await expect(page.locator('.pswp')).toHaveCSS('opacity', '1')
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 320, y: 350 }],
    })
    for (const x of [290, 250, 200, 150, 100, 60]) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: 350 }],
      })
      await page.waitForTimeout(20) // Allow the library's gesture animation frame.
    }
    // The image follows the finger before release, rather than jumping afterward.
    await expect
      .poll(() =>
        page
          .locator('.pswp__container')
          .evaluate(
            (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41,
          ),
      )
      .toBeLessThan(-100)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  } finally {
    await client.detach()
  }
}
