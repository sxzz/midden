import { folders, mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// A sheet opened by a finger holds focus itself, so its first control, the
// red button of a confirmation, is neither focused nor ringed. From the
// keyboard it starts on that control, as before.

const folder = folders[0]!
const confirm = (page: Page) =>
  page.getByRole('dialog', { name: `删除收藏夹「${folder.name}」` })

test.describe('with touch', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('the confirmation’s red button is not focused or ringed', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto(`/folder/${folder.id}`)
    await page.getByRole('button', { name: '管理收藏夹' }).tap()
    await page
      .getByRole('dialog', { name: folder.name })
      .getByRole('button', { name: '删除收藏夹' })
      .tap()
    const sheet = confirm(page)
    await expect(sheet).toBeVisible()
    const red = sheet.getByRole('button', { name: '删除收藏夹' })
    await expect(red).toBeVisible()
    await expect(red).not.toBeFocused()
    expect(await red.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
      'none',
    )
    // Focus is in the sheet, for a screen reader to start there.
    await expect(sheet).toBeFocused()
    expect(
      await sheet.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none')
    await sheet.getByRole('button', { name: '取消' }).tap()
    await expect(sheet).toBeHidden()
  })
})

test.describe('with the keyboard', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false })

  test('the confirmation starts on its first button', async ({ page }) => {
    await mockDesktop(page)
    await page.goto(`/folder/${folder.id}`)
    await page.getByRole('button', { name: '管理收藏夹' }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await expect(
      page.getByRole('menuitem', { name: '删除收藏夹' }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    const sheet = confirm(page)
    await expect(sheet).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: '删除收藏夹' }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })
})
