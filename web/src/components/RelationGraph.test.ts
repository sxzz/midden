import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { graphModel, type GraphModel } from '../graph'
import { asset, mockApi } from '../testing/api'
import GraphNodeCard from './GraphNodeCard.vue'
import RelationGraph from './RelationGraph.vue'
import type { FollowGraph } from '../api'

const { push, canvas } = vi.hoisted(() => ({
  push: vi.fn(),
  canvas: {
    shown: [] as GraphModel[],
    onSelect: undefined as ((key: string | undefined) => void) | undefined,
    selected: [] as (string | undefined)[],
    killed: false,
  },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
// WebGL is out of reach here: the canvas records what it is asked to draw.
vi.mock('../graph-canvas', () => ({
  readTheme: () => ({}),
  createGraphCanvas: (
    _el: HTMLElement,
    options: { onSelect: (key: string | undefined) => void },
  ) => {
    canvas.onSelect = options.onSelect
    return {
      show: (model: GraphModel) => canvas.shown.push(model),
      select: (key: string | undefined) => canvas.selected.push(key),
      setTheme: () => {},
      resize: () => {},
      kill: () => (canvas.killed = true),
    }
  },
}))

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
  canvas.shown = []
  canvas.selected = []
  canvas.killed = false
})

const graph = (total = 2): FollowGraph => ({
  nodes: [
    { entity_id: 'c', external_id: '100', name: 'Center', collection_id: 'cc' },
    {
      entity_id: 'm',
      external_id: '1',
      name: '小林',
      username: 'kobayashi',
      followers: 12_345,
      following: 67,
      kind: 'mutual',
      collection_id: 'mc',
      avatar: asset({ id: 'a', purpose: 'avatar', remote_url: 'https://x/a' }),
    },
    {
      entity_id: 'o',
      external_id: '2',
      username: 'outside',
      kind: 'followers',
    },
  ],
  edges: [
    [0, 1],
    [1, 0],
    [2, 0],
  ],
  total,
  kinds: { following: 4, followers: 1, mutual: 1 },
  lists: {
    following: { complete_at: '2026-11-20T08:00:00.000Z' },
    followers: {},
  },
})

const text = (el: Element | null | undefined) =>
  el?.textContent?.replaceAll(/\s+/g, ' ').trim()

async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(answer: (path: string) => unknown) {
  const api = mockApi(answer)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(RelationGraph, { id: 'cc' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(api).toHaveBeenCalled())
  await vi.waitFor(() => expect(canvas.shown.length).toBeGreaterThan(0))
  await settle()
  return { el, api }
}

it('shows all three kinds at first, with counts and how complete the lists are', async () => {
  const { el, api } = await mount(() => graph())
  expect(api).toHaveBeenCalledWith('/collections/cc/graph?limit=300', {
    method: 'GET',
    signal: expect.any(AbortSignal),
  })
  expect([...el.querySelectorAll('.chip')].map(text)).toEqual([
    '关注4',
    '粉丝1',
    '互关1',
  ])
  expect(
    [...el.querySelectorAll('.chip')].map((c) =>
      c.getAttribute('aria-pressed'),
    ),
  ).toEqual(['true', 'true', 'true'])
  expect(text(el.querySelector('.lists'))).toMatch(
    /^关注名单 11-2\d 完整抓取 · 粉丝名单未抓取$/,
  )
  expect(canvas.shown.at(-1)!.nodes.map((n) => n.key)).toEqual(['c', 'm', 'o'])
  // Everything is shown: nothing more to ask for.
  expect(el.querySelector('.more')).toBeNull()
})

it('turns a kind off, and asks for more beyond the first accounts', async () => {
  const { el, api } = await mount(() => graph(900))
  expect(text(el.querySelector('.more'))).toBe('显示更多2 / 900')
  ;(el.querySelector('.more') as HTMLButtonElement).click()
  await settle()
  expect(api).toHaveBeenLastCalledWith(
    '/collections/cc/graph?limit=600',
    expect.anything(),
  )
  ;(el.querySelectorAll('.chip')[1] as HTMLButtonElement).click()
  await settle()
  expect(api).toHaveBeenLastCalledWith(
    `/collections/cc/graph?kinds=${encodeURIComponent('following,mutual')}&limit=300`,
    expect.anything(),
  )
  expect(el.querySelectorAll('.chip')[1]!.getAttribute('aria-pressed')).toBe(
    'false',
  )
})

it('opens a card for the tapped account and goes from it', async () => {
  const { el } = await mount(() => graph())
  canvas.onSelect!('m')
  await settle()
  const card = el.querySelector('.card')!
  expect(text(card.querySelector('.name'))).toBe('小林')
  expect(text(card.querySelector('.handle'))).toBe('@kobayashi')
  expect(text(card.querySelector('.meta'))).toBe('互关关注 67粉丝 12,345')
  expect(card.querySelector('img')?.getAttribute('referrerpolicy')).toBe(
    'no-referrer',
  )
  expect(canvas.selected.at(-1)).toBe('m')
  const buttons = [...card.querySelectorAll('.actions button')]
  expect(buttons.map(text)).toEqual(['以他为中心', '打开详情'])
  ;(buttons[0] as HTMLButtonElement).click()
  expect(push).toHaveBeenLastCalledWith({
    name: 'collection-graph',
    params: { id: 'mc' },
  })
  ;(buttons[1] as HTMLButtonElement).click()
  expect(push).toHaveBeenLastCalledWith({
    name: 'collection',
    params: { id: 'mc' },
  })
  // Tapping the stage closes it.
  canvas.onSelect!(undefined)
  await settle()
  expect(el.querySelector('.card')).toBeNull()
})

it('kills the canvas with the page', async () => {
  await mount(() => graph())
  unmount()
  unmount = () => {}
  expect(canvas.killed).toBe(true)
})

it('offers no way on from an account the page may not link to', () => {
  const [, , outside] = graphModel(graph()).nodes
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(GraphNodeCard, { view: outside })
  app.mount(el)
  unmount = () => app.unmount()
  expect(text(el.querySelector('.name'))).toBe('@outside')
  expect(text(el.querySelector('.initial'))).toBe('O')
  expect(el.querySelector('.actions')).toBeNull()
  // The center is where the page is: only its details.
  const [center] = graphModel(graph()).nodes
  app.unmount()
  const again = createVaporApp(GraphNodeCard, { view: center })
  again.mount(el)
  unmount = () => again.unmount()
  expect([...el.querySelectorAll('.actions button')].map(text)).toEqual([
    '打开详情',
  ])
})
