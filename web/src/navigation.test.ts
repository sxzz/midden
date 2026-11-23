import { expect, it, vi } from 'vitest'
import { followInternalLink, goBack } from './navigation'
import type { Router } from 'vue-router'
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
})
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
