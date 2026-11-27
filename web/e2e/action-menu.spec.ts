import { folders, mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// A menu of actions is a dropdown under its button when a mouse opens it,
// and the action sheet when a finger does: the input decides, not the width.

const folder = folders[0]!
const trigger = (page: Page) => page.getByRole('button', { name: '管理收藏夹' })

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false })

  test('the folder menu drops down under its button, without title or 取消', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto(`/app/folder/${folder.id}`)
    await trigger(page).click()
    const menu = page.getByRole('menu', { name: folder.name })
    await expect(menu).toBeVisible()
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(menu.getByRole('menuitem')).toHaveText([
      '更新收藏夹',
      '定期更新',
      '公开分享',
      '重命名',
      '删除收藏夹',
    ])
    await expect(menu.getByText('取消')).toHaveCount(0)
    await expect(menu.getByText(folder.name)).toHaveCount(0)
    // Red, as in the sheet.
    const red = await menu
      .getByRole('menuitem', { name: '删除收藏夹' })
      .evaluate((el) => getComputedStyle(el).color)
    const plain = await menu
      .getByRole('menuitem', { name: '重命名' })
      .evaluate((el) => getComputedStyle(el).color)
    expect(red).not.toBe(plain)
    // Just under the button, its right edge on the button's.
    const button = (await trigger(page).boundingBox())!
    const box = (await menu.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(button.y + button.height)
    expect(box.y).toBeLessThan(button.y + button.height + 10)
    expect(
      Math.abs(box.x + box.width - (button.x + button.width)),
    ).toBeLessThan(1)

    // Esc closes it, and focus is back on the button.
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger(page)).toBeFocused()

    // A click outside only closes it: what is under it is not clicked.
    await trigger(page).click()
    await expect(menu).toBeVisible()
    const url = page.url()
    await page.getByRole('link', { name: '设置', exact: true }).first().click()
    await expect(menu).toBeHidden()
    expect(page.url()).toBe(url)
    // The button closes it again, rather than opening it once more.
    await trigger(page).click()
    await expect(menu).toBeVisible()
    await trigger(page).click()
    await expect(menu).toBeHidden()
  })

  test('the menu is worked from the keyboard', async ({ page }) => {
    await mockDesktop(page)
    await page.goto(`/app/folder/${folder.id}`)
    await trigger(page).focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: folder.name })
    const item = (name: string) => menu.getByRole('menuitem', { name })
    await expect(item('更新收藏夹')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(item('定期更新')).toBeFocused()
    await page.keyboard.press('End')
    await expect(item('删除收藏夹')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(item('更新收藏夹')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(item('删除收藏夹')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(item('更新收藏夹')).toBeFocused()
    // Tab leaves the menu, closed.
    await page.keyboard.press('Tab')
    await expect(menu).toBeHidden()

    await trigger(page).focus()
    await page.keyboard.press(' ')
    await expect(item('更新收藏夹')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(item('重命名')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(
      page.getByRole('dialog', { name: '重命名收藏夹' }),
    ).toBeVisible()
  })

  test('deleting the folder from the menu still asks first', async ({
    page,
  }) => {
    const deletes: string[] = []
    await mockDesktop(page)
    page.on('request', (request) => {
      if (request.method() === 'DELETE') deletes.push(request.url())
    })
    await page.goto(`/app/folder/${folder.id}`)
    await trigger(page).click()
    await page.getByRole('menuitem', { name: '删除收藏夹' }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    const confirm = page.getByRole('dialog', {
      name: `删除收藏夹「${folder.name}」`,
    })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(confirm).toBeHidden()
    expect(deletes).toEqual([])
    // Focus is back where the menu was opened.
    await expect(trigger(page)).toBeFocused()
  })

  test('near the bottom edge the menu opens above its button', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await page.getByRole('button', { name: '多选' }).click()
    await page.getByRole('checkbox').first().click()
    const more = page.getByRole('button', { name: '更多操作' })
    await more.click()
    const menu = page.getByRole('menu', { name: '已选 1 项' })
    await expect(menu).toBeVisible()
    const button = (await more.boundingBox())!
    const box = (await menu.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(button.y)
    expect(box.y + box.height).toBeGreaterThan(button.y - 10)
    // Inside the window.
    expect(box.x + box.width).toBeLessThanOrEqual(1280)
    await expect(
      menu.getByRole('menuitem', { name: '删除', exact: true }),
    ).toBeVisible()
  })
})

test.describe('with touch', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('the same button opens the action sheet, its first action unringed', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto(`/app/folder/${folder.id}`)
    await trigger(page).tap()
    const sheet = page.getByRole('dialog', { name: folder.name })
    await expect(sheet).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
    const first = sheet.getByRole('button', { name: '更新收藏夹' })
    await expect(first).toBeVisible()
    // The sheet holds focus, not its first action, which shows no ring.
    await expect(first).not.toBeFocused()
    expect(
      await first.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none')
    await sheet.getByRole('button', { name: '取消' }).tap()
    await expect(sheet).toBeHidden()

    // The 多选 bar's menu too.
    await page.goto('/app/')
    await page.getByRole('button', { name: '多选' }).tap()
    await page.getByRole('checkbox').first().tap()
    await page.getByRole('button', { name: '更多操作' }).tap()
    const selection = page.getByRole('dialog', { name: '已选 1 项' })
    await expect(
      selection.getByRole('button', { name: '删除', exact: true }),
    ).toBeVisible()
    await expect(selection.getByRole('button', { name: '取消' })).toBeVisible()
  })
})
