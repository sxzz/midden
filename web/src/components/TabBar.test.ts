import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { emptyStates, RESET_STATE, SWITCH_STATE, tabStates } from '../tab-state'
import { suppressTabBar } from '../tabbar'
import TabBar from './TabBar.vue'

const { router, route } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  route: { name: 'collections' as string, fullPath: '/' },
}))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  const { resolve } = await import('../testing/router')
  const current = reactive(route)
  Object.assign(route, { current })
  return {
    useRouter: () => ({
      ...router,
      // A remembered address, as the router splits it.
      resolve: (to: string | object) => {
        if (typeof to !== 'string') return resolve(to as never)
        const [path, query = ''] = to.split('?', 2)
        return {
          href: to,
          path,
          query: Object.fromEntries(new URLSearchParams(query)),
          hash: '',
        }
      },
    }),
    useRoute: () => current,
  }
})
const at = (name: string, fullPath: string) =>
  Object.assign((route as unknown as { current: typeof route }).current, {
    name,
    fullPath,
  })

let unmount = () => {}
beforeEach(() => {
  vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {})
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  at('collections', '/')
  tabStates.value = emptyStates()
})

const ACCOUNTS = '/?entity_type=x.profile,instagram.profile'
const CENTRE = '/relations?of=x%2Fx.profile%2F1'
/** Each tab as it was left: 探索 on a post, 设置 on a sub-page. */
function leftOn() {
  tabStates.value = {
    explore: { root: ACCOUNTS, stack: [ACCOUNTS, '/collection/1'], scroll: 0 },
    captures: {
      root: '/captures',
      stack: ['/captures', '/captures/1'],
      scroll: 0,
    },
    relations: { root: CENTRE, stack: [CENTRE], scroll: 0 },
    settings: {
      root: '/settings',
      stack: ['/settings', '/settings/admin'],
      scroll: 0,
    },
  }
}
/** A media query list that matches only the queries given. */
const media = (...matching: string[]) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching.includes(query),
    addEventListener() {},
    removeEventListener() {},
  }))
function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(TabBar)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const tab = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('a')].find((a) => a.textContent?.includes(label))!
const current = (el: HTMLElement) =>
  [...el.querySelectorAll('a[aria-current="page"]')].map((a) =>
    a.textContent?.trim(),
  )
const click = (target: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

it('links each other tab to the page it was left on, as a real link', async () => {
  leftOn()
  at('relations', CENTRE)
  const el = mount()
  expect(tab(el, '探索').getAttribute('href')).toBe('/collection/1')
  expect(tab(el, '设置').getAttribute('href')).toBe('/settings/admin')
  expect(tab(el, '采集').getAttribute('href')).toBe('/captures/1')
  leftOn()
  tabStates.value = {
    ...tabStates.value,
    settings: { root: '/settings', stack: ['/settings?a=1'], scroll: 0 },
  }
  await nextTick()
  expect(tab(el, '设置').getAttribute('href')).toBe('/settings?a=1')
  // The open tab leads to its plain root, as tapping it does.
  expect(tab(el, '关系').getAttribute('href')).toBe('/relations')
  at('collection', '/collection/1')
  await nextTick()
  expect(tab(el, '探索').getAttribute('href')).toBe('/')
  expect(tab(el, '关系').getAttribute('href')).toBe(CENTRE)
  expect(el.querySelector('nav')?.getAttribute('aria-label')).toBe('主导航')
})

it('lights the tab of the page shown, nested pages included', async () => {
  const el = mount()
  expect(current(el)).toEqual(['探索'])
  for (const [name, label] of [
    ['collection', '探索'],
    ['captures', '采集'],
    ['capture', '采集'],
    ['relations', '关系'],
    ['collection-graph', '关系'],
    ['compare', '关系'],
    ['settings', '设置'],
    ['captures-watches', '采集'],
  ]) {
    at(name!, `/${name}`)
    await nextTick()
    expect(current(el)).toEqual([label])
  }
})

it('scrolls to the top when the open tab is tapped on its root', () => {
  const el = mount()
  const event = click(tab(el, '探索').querySelector('span')!)
  expect(event.defaultPrevented).toBe(true)
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  expect(router.push).not.toHaveBeenCalled()
})

it('resets the open tab to its plain root when tapped elsewhere in it', async () => {
  leftOn()
  const el = mount()
  at('collection', '/collection/1')
  await nextTick()
  click(tab(el, '探索'))
  expect(window.scrollTo).not.toHaveBeenCalled()
  expect(router.push).toHaveBeenCalledWith({ path: '/', state: RESET_STATE })
  // On the root itself, but filtered: the filters go too.
  at('collections', ACCOUNTS)
  await nextTick()
  const event = click(tab(el, '探索'))
  expect(event.defaultPrevented).toBe(true)
  expect(router.push).toHaveBeenLastCalledWith({
    path: '/',
    state: RESET_STATE,
  })
  // 采集's other tab, with its dialog open, goes back to 采集记录.
  at('captures-watches', '/captures/watches?dialog=accounts')
  await nextTick()
  click(tab(el, '采集'))
  expect(router.push).toHaveBeenLastCalledWith({
    path: '/captures',
    state: RESET_STATE,
  })
  expect(window.scrollTo).not.toHaveBeenCalled()
  // Another tab returns to where it was left, marked as the bar's.
  click(tab(el, '设置'))
  expect(router.push).toHaveBeenLastCalledWith({
    path: '/settings/admin',
    query: {},
    hash: '',
    state: SWITCH_STATE,
  })
})

it('leaves a modified click to the browser, for a new tab', () => {
  const el = mount()
  for (const init of [{ metaKey: true }, { ctrlKey: true }]) {
    const event = click(tab(el, '探索'), init)
    expect(event.defaultPrevented).toBe(false)
  }
  click(tab(el, '设置'), { metaKey: true })
  expect(router.push).not.toHaveBeenCalled()
  expect(window.scrollTo).not.toHaveBeenCalled()
})

it('hides while the page scrolls down and while a page holds it down', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(10_000)
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: 5000,
  })
  const el = mount()
  const nav = el.querySelector('nav')!
  const scrollTo = async (y: number) => {
    Object.defineProperty(globalThis, 'scrollY', {
      configurable: true,
      value: y,
    })
    dispatchEvent(new Event('scroll'))
    await nextTick()
  }
  expect(document.body.dataset.tabBar).toBe('shown')
  await scrollTo(100)
  await scrollTo(300)
  expect(nav.classList.contains('hidden')).toBe(true)
  expect(document.body.dataset.tabBar).toBe('hidden')
  await scrollTo(250)
  expect(nav.classList.contains('hidden')).toBe(false)
  // The 多选 bar takes its place.
  suppressTabBar('test', true)
  await nextTick()
  expect(nav.classList.contains('hidden')).toBe(true)
  suppressTabBar('test', false)
  await nextTick()
  expect(nav.classList.contains('hidden')).toBe(false)
  unmount()
  unmount = () => {}
  expect(document.body.dataset.tabBar).toBeUndefined()
  Object.defineProperty(globalThis, 'scrollY', { configurable: true, value: 0 })
})

it('stays out of the keyboard’s way on a touch screen', async () => {
  media('(pointer: coarse)')
  const el = mount()
  const nav = el.querySelector('nav')!
  const field = document.createElement('textarea')
  const box = Object.assign(document.createElement('input'), {
    type: 'checkbox',
  })
  document.body.append(field, box)
  field.focus()
  await nextTick()
  expect(nav.classList.contains('hidden')).toBe(true)
  box.focus()
  await nextTick()
  expect(nav.classList.contains('hidden')).toBe(false)
  vi.unstubAllGlobals()
})
