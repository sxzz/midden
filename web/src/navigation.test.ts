import { afterEach, expect, it, vi } from 'vitest'
import {
  followInternalLink,
  goBack,
  navigatesHere,
  openInNewTab,
} from './navigation'
import { shareSlug } from './share'
import type { Router } from 'vue-router'
afterEach(() => {
  vi.unstubAllGlobals()
  shareSlug.value = ''
})
/** Inside Telegram's Mini App, signed in. */
const miniApp = () =>
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed' } })
function fixture(back: string | null = null) {
  return {
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    options: { history: { state: { back } } },
  } as unknown as Router
}
it('returns through router history, with home only as the deep-link fallback', () => {
  const router = fixture('/collection/previous')
  goBack(router)
  expect(router.back).toHaveBeenCalledOnce()
  expect(router.replace).not.toHaveBeenCalled()
  router.options.history.state.back = null
  goBack(router)
  expect(router.replace).toHaveBeenCalledWith({ name: 'collections' })
  // Inside a public link, its start.
  shareSlug.value = 'slug'
  goBack(router)
  expect(router.replace).toHaveBeenLastCalledWith({
    name: 'share',
    params: { slug: 'slug' },
  })
})
it.each([
  [{}, true],
  [{ ctrlKey: true }, false],
  [{ metaKey: true }, false],
  [{ shiftKey: true }, false],
  [{ altKey: true }, false],
  [{ button: 1 }, false],
])('tells a click that stays in the page: %o', (options, here) => {
  expect(navigatesHere(new MouseEvent('click', options))).toBe(here)
  // The Mini App has no tabs: every click with the main or middle button
  // navigates in place.
  miniApp()
  expect(navigatesHere(new MouseEvent('click', options))).toBe(true)
})
it('opens a route in a new tab by its hash address', () => {
  const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
  const router = {
    resolve: () => ({ href: '#/collection/c' }),
  } as unknown as Router
  openInNewTab(router, { name: 'collection', params: { id: 'c' } })
  expect(open).toHaveBeenCalledWith('#/collection/c', '_blank', 'noopener')
  open.mockRestore()
})
it.each([{ metaKey: true }, { button: 1 }])(
  'follows a modified click in place inside the Mini App %o',
  (options) => {
    miniApp()
    const router = fixture()
    const link = document.createElement('a')
    link.href = '#/collection/detail'
    const event = new MouseEvent('click', { cancelable: true, ...options })
    Object.defineProperty(event, 'target', { value: link })
    followInternalLink(router, event)
    expect(event.defaultPrevented).toBe(true)
    expect(router.push).toHaveBeenCalledWith('/collection/detail')
  },
)
it.each([
  {},
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
])('preserves native link gestures %o', (options) => {
  const router = fixture()
  const link = document.createElement('a')
  link.href = '#/collection/detail'
  const event = new MouseEvent('click', { cancelable: true, ...options })
  Object.defineProperty(event, 'target', { value: link })
  followInternalLink(router, event)
  const ordinary = Object.keys(options).length === 0
  expect(event.defaultPrevented).toBe(ordinary)
  expect(router.push).toHaveBeenCalledTimes(ordinary ? 1 : 0)
  if (ordinary) expect(router.push).toHaveBeenCalledWith('/collection/detail')
})
