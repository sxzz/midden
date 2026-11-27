import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createApp,
  createVaporApp,
  h,
  KeepAlive,
  nextTick,
  shallowRef,
  vaporInteropPlugin,
} from 'vue'
import { APIError, type Watch, type WatchTarget } from '../api'
import { mockApi, type Request } from '../testing/api'
import WatchesView from './WatchesView.vue'
import WatchSheet from './WatchSheet.vue'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

let unmount = () => {}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const defaults = {
  posts: 'latest' as const,
  count: 100,
  media_only: false,
  include_shared: true,
  capture_references: true,
  relations: false,
}

const watch = (patch: Partial<Watch> = {}): Watch => ({
  id: 'w',
  target: 'collection',
  target_id: 'p',
  handle: 'cat',
  url: 'https://x.com/cat',
  every: { count: 1, unit: 'day' },
  time_zone: 'UTC',
  options: defaults,
  enabled: true,
  next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: '2026-11-20T00:00:00Z',
  ...patch,
})

const preview = { posts: 0, profiles: 1, listable: 1, name: '' }

async function mountSheet(target: WatchTarget, existing?: Watch) {
  const sent: { method: string; path: string; body?: unknown }[] = []
  mockApi((path, request: Request) => {
    if (path === '/updates/preview') return preview
    if (path.startsWith('/watches?'))
      return { items: existing ? [existing] : [] }
    sent.push({
      method: request.method,
      path,
      ...(request.body ? { body: JSON.parse(request.body) } : {}),
    })
    if (request.method === 'PUT')
      return watch({ ...(JSON.parse(request.body!) as object) })
    if (request.method === 'DELETE') return
    throw new Error(`unexpected ${path}`)
  })
  const changed: (Watch | undefined)[] = []
  const open = shallowRef(false)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(WatchSheet, {
    open: () => open.value,
    target: () => target,
    label: () => '@cat',
    onChanged: () => (w: Watch | undefined) => changed.push(w),
  })
  app.mount(el)
  unmount = () => app.unmount()
  open.value = true
  await nextTick()
  await vi.waitFor(() =>
    expect(el.querySelector('.action.strong')?.hasAttribute('disabled')).toBe(
      false,
    ),
  )
  const label = (text: string) =>
    [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(text),
    )
  const choose = async (text: string, value: string) => {
    const select = label(text)!.querySelector('select')!
    select.value = value
    select.dispatchEvent(new Event('change'))
    await nextTick()
  }
  const count = () =>
    el.querySelector<HTMLInputElement>('input[aria-label="间隔"]')!
  const unit = () =>
    el.querySelector<HTMLSelectElement>('select[aria-label="单位"]')!
  const setEvery = async (n: string, u?: string) => {
    if (u) {
      unit().value = u
      unit().dispatchEvent(new Event('change'))
    }
    count().value = n
    count().dispatchEvent(new Event('change'))
    await nextTick()
  }
  return { el, sent, changed, label, choose, count, unit, setEvery }
}

it('watches a profile every so many of a unit, with the 更新 options', async () => {
  const { el, sent, changed, label, choose, count, unit, setEvery } =
    await mountSheet({
      target: 'collection',
      id: 'p',
    })
  expect(el.querySelector('.head')?.textContent).toBe('定期更新 @cat')
  // Every day, with the defaults of 更新.
  expect(count().value).toBe('1')
  expect(unit().value).toBe('day')
  expect([...unit().options].map((o) => o.text.trim())).toEqual([
    '分钟',
    '小时',
    '天',
    '周',
    '月',
    '年',
  ])
  expect(el.querySelector('.every')?.textContent).toContain('最短 5 分钟')
  expect(label('抓帖子')!.querySelector('input')!.checked).toBe(true)
  expect(label('抓关系网')!.querySelector('input')!.checked).toBe(false)
  expect(el.querySelector('.action.destructive')).toBeNull()
  // Fewer than 5 minutes is made 5; more than 1000 is made 1000.
  await setEvery('2', 'minute')
  expect(count().value).toBe('5')
  await setEvery('5000')
  expect(count().value).toBe('1000')
  await setEvery('6', 'hour')
  await choose('帖子范围', 'until_existing')
  label('抓关系网')!.querySelector('input')!.click()
  await nextTick()
  const save = el.querySelector<HTMLButtonElement>('.action.strong')!
  expect(save.textContent?.trim()).toBe('开启定期更新')
  save.click()
  await vi.waitFor(() => expect(changed).toHaveLength(1))
  expect(sent).toEqual([
    {
      method: 'PUT',
      path: '/watches',
      body: {
        target: 'collection',
        id: 'p',
        every: { count: 6, unit: 'hour' },
        time_zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        options: {
          ...defaults,
          posts: 'until_existing',
          count: undefined,
          relations: true,
        },
      },
    },
  ])
})

it('shows and edits a watch: next run, last run, removal', async () => {
  const existing = watch({
    every: { count: 2, unit: 'month' },
    options: { ...defaults, count: 20 },
    last_run: {
      id: 'run',
      state: 'complete',
      done: true,
      created_at: new Date().toISOString(),
    },
  })
  const { el, sent, changed, label, count, unit } = await mountSheet(
    { target: 'collection', id: 'p' },
    existing,
  )
  expect(count().value).toBe('2')
  expect(unit().value).toBe('month')
  expect(label('条数')!.querySelector('input')!.value).toBe('20')
  const facts = [...el.querySelectorAll('.fact')].map((p) => p.textContent)
  expect(facts[0]).toMatch(/^下次 (今天|明天) \d+:\d\d$/)
  expect(facts[1]).toMatch(/^上次 今天 \d+:\d\d · 已完成$/)
  expect(el.querySelector('.fact a')?.getAttribute('href')).toBe(
    '/app/captures/run',
  )
  expect(el.querySelector('.action.strong')?.textContent?.trim()).toBe('保存')
  el.querySelector<HTMLButtonElement>('.action.destructive')!.click()
  await vi.waitFor(() => expect(changed).toEqual([undefined]))
  expect(sent).toEqual([{ method: 'DELETE', path: '/watches/w' }])
})

function mountView() {
  const el = document.createElement('div')
  document.body.append(el)
  // The settings page lives in the library's KeepAlive, which loads it.
  const app = createApp({
    render: () => h(KeepAlive, null, [h(WatchesView)]),
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}

it('settings list every watch, and turn one off or remove it', async () => {
  let items = [
    watch(),
    watch({
      id: 'f',
      target: 'folder',
      target_id: 'folder',
      name: '猫',
      handle: undefined,
      url: undefined,
      every: { count: 6, unit: 'hour' },
      enabled: false,
      error: '收藏夹是空的',
    }),
  ]
  const sent: { method: string; path: string; body?: unknown }[] = []
  mockApi((path, request) => {
    if (path === '/watches' && request.method === 'GET') return { items }
    sent.push({
      method: request.method,
      path,
      ...(request.body ? { body: JSON.parse(request.body) } : {}),
    })
    if (request.method === 'PATCH') {
      const patch = JSON.parse(request.body!) as Partial<Watch>
      items = items.map((w) => (w.id === 'w' ? { ...w, ...patch } : w))
      return items[0]
    }
    if (request.method === 'DELETE') return
    throw new APIError(404, 'not found')
  })
  const el = mountView()
  await vi.waitFor(() => expect(el.querySelectorAll('.watch')).toHaveLength(2))
  const rows = [...el.querySelectorAll('.watch')]
  expect(rows[0]!.querySelector('.name')?.textContent).toBe('@cat')
  expect(rows[0]!.querySelector('.name')?.getAttribute('href')).toBe(
    '/app/collection/p',
  )
  expect(rows[0]!.textContent).toContain('每天 · 最新 100 条')
  expect(rows[1]!.querySelector('.name')?.textContent).toBe('收藏夹「猫」')
  expect(rows[1]!.textContent).toContain('每 6 小时')
  expect(rows[1]!.textContent).toContain('已关闭')
  expect(rows[1]!.textContent).toContain('上次未开始：收藏夹是空的')

  const toggle = rows[0]!.querySelector<HTMLInputElement>('.switch')!
  expect(toggle.checked).toBe(true)
  toggle.click()
  await vi.waitFor(() => expect(el.textContent).toContain('已关闭'))
  expect(sent).toEqual([
    { method: 'PATCH', path: '/watches/w', body: { enabled: false } },
  ])
})

it('says so when nothing is watched', async () => {
  mockApi(() => ({ items: [] }))
  const el = mountView()
  await vi.waitFor(() => expect(el.textContent).toContain('没有定期更新'))
})
