import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { lastCenter, rememberCenter } from '../graph-center'
import { mockApi } from '../testing/api'
import RelationsView from './RelationsView.vue'
import type { FollowGraph, Perspective } from '../api'

const { replace, route } = vi.hoisted(() => ({
  replace: vi.fn(),
  route: { name: 'relations', query: {} as Record<string, string> },
}))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  const { resolve } = await import('../testing/router')
  const current = reactive(route)
  Object.assign(route, { current })
  return {
    useRouter: () => ({
      push: vi.fn(),
      resolve,
      replace: (to: { query: Record<string, string> }) => {
        replace(to)
        current.query = to.query
      },
    }),
    useRoute: () => current,
  }
})
vi.mock('../graph-canvas', () => ({
  readTheme: () => ({}),
  createGraphCanvas: () => ({
    show: () => {},
    select: () => {},
    setDim: () => {},
    setTheme: () => {},
    resize: () => {},
    kill: () => {},
  }),
}))

const OWN = 'x/x.profile/1'
const OTHER = 'x/x.profile/2'
const perspective = (id: string, own = false): Perspective => ({
  id,
  username: id.endsWith('1') ? 'me' : 'friend',
  following: {},
  followers: {},
  ...(own ? { own: true as const } : {}),
})
const graph = (key: string): FollowGraph => ({
  nodes: [{ entity_id: 'c', key, external_id: key.slice(-1), name: 'Center' }],
  edges: [],
  total: 0,
  kinds: { following: 0, followers: 0, mutual: 0 },
  lists: { following: {}, followers: {} },
})

let unmount = () => {}
beforeEach(() => localStorage.clear())
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.clearAllMocks()
  ;(route as unknown as { current: typeof route }).current.query = {}
})

async function mount(perspectives: Perspective[]) {
  const api = mockApi((path) => {
    if (path.startsWith('/collections/perspectives'))
      return { items: perspectives }
    if (path.startsWith('/collections/graph?')) {
      const of = new URLSearchParams(path.split('?', 2)[1]).get('of')!
      return graph(of)
    }
    return
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(RelationsView)
  app.mount(el)
  unmount = () => app.unmount()
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  const paths = api.mock.calls.map(([path]) => path)
  return { el, paths }
}

it('opens on the owner’s own account, and remembers it', async () => {
  rememberCenter(OTHER)
  const { el, paths } = await mount([
    perspective(OTHER),
    perspective(OWN, true),
  ])
  expect(replace).toHaveBeenCalledWith({ query: { of: OWN } })
  // Marked by itself it would only repeat its rings: no viewer is asked for.
  expect(paths).toContain(
    `/collections/graph?of=${encodeURIComponent(OWN)}&limit=300`,
  )
  expect(el.querySelector('.graph-page')).not.toBeNull()
  expect(lastCenter()).toBe(OWN)
})

it('opens on the account last opened when the owner has none', async () => {
  rememberCenter(OTHER)
  await mount([perspective('x/x.profile/3'), perspective(OTHER)])
  expect(replace).toHaveBeenCalledWith({ query: { of: OTHER } })
})

it('shows the account the address names', async () => {
  ;(route as unknown as { current: typeof route }).current.query = {
    of: OTHER,
  }
  const { paths } = await mount([perspective(OWN, true)])
  expect(replace).not.toHaveBeenCalled()
  expect(paths.some((path) => path.startsWith('/collections/graph?of='))).toBe(
    true,
  )
  expect(paths.find((path) => path.startsWith('/collections/graph'))).toContain(
    encodeURIComponent(OTHER),
  )
})

it('shows only the picker without any relation data', async () => {
  const { el, paths } = await mount([])
  expect(replace).not.toHaveBeenCalled()
  expect(el.querySelector('.graph-page')).toBeNull()
  expect(paths.some((path) => path.startsWith('/collections/graph'))).toBe(
    false,
  )
  // Nothing but the picker, which reads its label alone.
  expect(
    [...el.querySelector('.relations')!.children].map((c) => c.className),
  ).toEqual(['picker'])
  expect(el.querySelector('summary')?.textContent?.trim()).toBe('中心')
})
