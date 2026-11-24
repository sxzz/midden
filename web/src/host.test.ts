import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  document.head.replaceChildren()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const scripts = () =>
  [...document.head.querySelectorAll('script')].map((s) => s.src)
const SDK = 'https://telegram.org/js/telegram-web-app.js'

it('never loads the Telegram script for a public link', async () => {
  const { loadHost } = await import('./host')
  await loadHost('#/s/AbCdEfGhIjKlMnOpQrStUv_-/collection/1')
  expect(scripts()).toEqual([])
})

it('loads the Telegram script once for the owner, settling even if it fails', async () => {
  const { loadHost } = await import('./host')
  let settled = false
  const first = loadHost('#tgWebAppData=signed').then(() => (settled = true))
  void loadHost('#/')
  expect(scripts()).toEqual([SDK])
  await Promise.resolve()
  expect(settled).toBe(false)
  document.head.querySelector('script')!.dispatchEvent(new Event('error'))
  await first
  expect(settled).toBe(true)
  await loadHost('#/collection/1')
  expect(scripts()).toEqual([SDK])
})

it('leaves a Telegram already present alone', async () => {
  vi.stubGlobal('Telegram', { WebApp: { initData: 'fixture' } })
  const { loadHost } = await import('./host')
  await loadHost('#/')
  expect(scripts()).toEqual([])
})
