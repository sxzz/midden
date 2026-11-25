import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { shareSlug } from '../../share'
import AppLink from './AppLink.vue'
import BackLink from './BackLink.vue'
import ListButton from './ListButton.vue'

const { router } = vi.hoisted(() => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    options: { history: { state: { back: null as string | null } } },
  },
}))
vi.mock('vue-router', async () => {
  const { resolve } = await import('../../testing/router')
  return { useRouter: () => ({ ...router, resolve }) }
})

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  router.options.history.state.back = null
  shareSlug.value = ''
})

function mount(
  component: Parameters<typeof createVaporApp>[0],
  props: Record<string, unknown>,
) {
  const el = document.createElement('div')
  document.body.append(el)
  // Vapor reads a function given to the root as the prop's getter.
  const app = createVaporApp(
    component,
    Object.fromEntries(
      Object.entries(props).map(([key, value]) => [
        key,
        typeof value === 'function' ? () => value : value,
      ]),
    ),
  )
  app.mount(el)
  unmount = () => app.unmount()
  return el
}

/** Click as the browser would, letting the page cancel it. */
function click(target: Element, options: MouseEventInit = {}) {
  const event = new MouseEvent(options.button === 1 ? 'auxclick' : 'click', {
    bubbles: true,
    cancelable: true,
    ...options,
  })
  target.dispatchEvent(event)
  return event
}

const COLLECTION = { name: 'collection', params: { id: 'c1' } }

it('links to a route by its hash address and follows a plain click through the router', () => {
  const navigate = vi.fn()
  const el = mount(AppLink, { to: COLLECTION, onNavigate: navigate })
  const link = el.querySelector('a')!
  expect(link.getAttribute('href')).toBe('#/collection/c1')
  expect(link.hasAttribute('target')).toBe(false)
  const event = click(link)
  expect(event.defaultPrevented).toBe(true)
  expect(navigate).toHaveBeenCalledOnce()
  expect(router.push).toHaveBeenCalledWith(COLLECTION)
})

it.each([
  { metaKey: true },
  { ctrlKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
])('leaves a modified or middle click to the browser %o', (options) => {
  const navigate = vi.fn()
  const el = mount(AppLink, { to: COLLECTION, onNavigate: navigate })
  const event = click(el.querySelector('a')!, options)
  expect(event.defaultPrevented).toBe(false)
  expect(navigate).not.toHaveBeenCalled()
  expect(router.push).not.toHaveBeenCalled()
})

it('navigates in place on any click inside the Mini App', () => {
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed' } })
  const el = mount(AppLink, { to: COLLECTION })
  for (const options of [{ metaKey: true }, { button: 1 }]) {
    expect(click(el.querySelector('a')!, options).defaultPrevented).toBe(true)
  }
  expect(router.push).toHaveBeenCalledTimes(2)
})

it('replaces the entry when asked', () => {
  const el = mount(AppLink, { to: '/captures', replace: true })
  click(el.querySelector('a')!)
  expect(router.replace).toHaveBeenCalledWith('/captures')
  expect(router.push).not.toHaveBeenCalled()
})

it('takes an app address as href, and opens another site in a new tab', () => {
  const inside = mount(AppLink, { href: '#/collection/c2' })
  click(inside.querySelector('a')!)
  expect(router.push).toHaveBeenCalledWith('/collection/c2')
  unmount()
  const outside = mount(AppLink, { href: 'https://x.com/someone' })
  const link = outside.querySelector('a')!
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  link.addEventListener('click', (event) => event.preventDefault())
  click(link)
  expect(router.push).toHaveBeenCalledOnce()
  unmount()
  // Nothing to link to: no address at all.
  const none = mount(AppLink, {})
  expect(none.querySelector('a')!.hasAttribute('href')).toBe(false)
})

it('renders a list row as a link with `to`, another site with `href`, an action otherwise', () => {
  const navigate = vi.fn()
  const el = mount(ListButton, {
    label: '统计趋势',
    chevron: true,
    to: { name: 'collection-stats', params: { id: 'c1' } },
    onNavigate: navigate,
  })
  const row = el.querySelector('a.row')!
  expect(row.getAttribute('href')).toBe('#/collection/c1/stats')
  expect(row.textContent).toContain('统计趋势')
  expect(row.querySelector('.chevron')).not.toBeNull()
  click(row)
  expect(router.push).toHaveBeenCalledWith({
    name: 'collection-stats',
    params: { id: 'c1' },
  })
  expect(navigate).toHaveBeenCalledOnce()
  unmount()
  const external = mount(ListButton, {
    label: '打开原文',
    href: 'https://x.com/someone',
  })
  expect(external.querySelector('a.row')!.getAttribute('target')).toBe('_blank')
  unmount()
  const select = vi.fn()
  const action = mount(ListButton, { label: '更新', onSelect: select })
  expect(action.querySelector('a')).toBeNull()
  action.querySelector('button')!.click()
  expect(select).toHaveBeenCalledOnce()
})

it('goes back through history, linking to the same page for a new tab', () => {
  router.options.history.state.back = '/collection/c1'
  const el = mount(BackLink, {})
  const link = el.querySelector('a')!
  expect(link.getAttribute('href')).toBe('#/collection/c1')
  expect(click(link).defaultPrevented).toBe(true)
  expect(router.back).toHaveBeenCalledOnce()
  // A new tab opens it; this page stays.
  expect(click(link, { metaKey: true }).defaultPrevented).toBe(false)
  expect(router.back).toHaveBeenCalledOnce()
  unmount()
  // Opened directly inside a share: back to its start.
  router.options.history.state.back = null
  shareSlug.value = 'slug'
  const shared = mount(BackLink, {})
  expect(shared.querySelector('a')!.getAttribute('href')).toBe('#/s/slug')
  click(shared.querySelector('a')!)
  expect(router.replace).toHaveBeenCalledWith({
    name: 'share',
    params: { slug: 'slug' },
  })
})
