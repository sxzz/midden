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
    camera: [] as string[],
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
      zoomIn: () => canvas.camera.push('in'),
      zoomOut: () => canvas.camera.push('out'),
      fit: () => canvas.camera.push('fit'),
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
  canvas.camera = []
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

it('zooms and frames the graph from its buttons', async () => {
  const { el } = await mount(() => graph())
  const buttons = [...el.querySelectorAll('.zoom button')]
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
    '放大',
    '缩小',
    '显示全部',
  ])
  for (const button of buttons) (button as HTMLButtonElement).click()
  expect(canvas.camera).toEqual(['in', 'out', 'fit'])
})

it('lists the same accounts by kind, and opens the same card from the list', async () => {
  const many: FollowGraph = {
    ...graph(),
    nodes: [
      ...graph().nodes,
      {
        entity_id: 'p',
        external_id: '3',
        name: '大号',
        followers: 9,
        kind: 'followers',
      },
      {
        entity_id: 'q',
        external_id: '4',
        name: '小号',
        followers: 1,
        kind: 'mutual',
      },
    ],
  }
  const { el } = await mount(() => many)
  const modes = [...el.querySelectorAll('.modes button')]
  expect(modes.map(text)).toEqual(['图谱', '列表'])
  expect(modes[0]!.getAttribute('aria-pressed')).toBe('true')
  expect(el.querySelector('.list')).toBeNull()
  ;(modes[1] as HTMLButtonElement).click()
  await settle()
  expect(modes[1]!.getAttribute('aria-pressed')).toBe('true')
  // The canvas stays, hidden, for coming back.
  expect((el.querySelector('.surface') as HTMLElement).style.display).toBe(
    'none',
  )
  expect(el.querySelector('.zoom')).toBeNull()
  const sections = [...el.querySelectorAll('.list section')]
  expect(sections.map((s) => text(s.querySelector('h2')))).toEqual([
    '互关2',
    '粉丝2',
  ])
  expect(
    sections.map((s) => [...s.querySelectorAll('.name')].map(text)),
  ).toEqual([
    ['小林', '小号'],
    ['大号', '@outside'],
  ])
  expect(text(sections[0]!.querySelector('.followers'))).toBe('粉丝 12,345')
  // A sensitive or missing avatar is its initial.
  expect(text(sections[1]!.querySelectorAll('.initial')[1])).toBe('O')
  ;(sections[1]!.querySelector('.person') as HTMLButtonElement).click()
  await settle()
  expect(text(el.querySelector('.card .name'))).toBe('大号')
  expect(sections[1]!.querySelector('.person')!.classList).toContain('on')
  ;(modes[0] as HTMLButtonElement).click()
  await settle()
  // Back on the graph, the same account stays chosen.
  expect(canvas.selected.at(-1)).toBe('p')
  expect(text(el.querySelector('.card .name'))).toBe('大号')
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
