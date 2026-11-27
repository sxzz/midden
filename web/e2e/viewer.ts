import type { Page } from '@playwright/test'

/** The viewer's thumbnail for item `n` (counting from 1). */
export const thumb = (page: Page, n: number) =>
  page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(`^第${n}项`) })
