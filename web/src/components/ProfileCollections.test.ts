import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { mockApi } from '../testing/api'
import ProfileCollections from './ProfileCollections.vue'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})
let unmount = () => {}
it('loads Instagram profile members with their own platform entity type', async () => {
  const request = mockApi()
  request.mockResolvedValue({ items: [], total_storage_bytes: 0 })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'instagram-profile',
    revisionId: 'r1',
    platform: 'instagram',
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(request).toHaveBeenCalled())
  const query = new URL(
    String(request.mock.calls[0]![0]),
    'https://example.test',
  ).searchParams
  expect(query.get('entity_type')).toBe('instagram.post')
  expect(query.get('related_to')).toBe('instagram-profile')
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
it('shows related posts using the library and the total across all pages', async () => {
  const request = mockApi()
  request.mockResolvedValue({
    items: [
      {
        id: 'post',
        url: 'https://example.test/post',
        text: '关联帖子',
        author_name: '作者',
        observed_at: '2026-10-01T00:00:00Z',
        visibility: 'public',
        revision_id: 'r1',
        assets: [],
        storage_bytes: 512,
      },
    ],
    total_storage_bytes: 4096,
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('关联帖子'))
  expect(el.textContent).toContain('帖子占用总量4.0 KB')
  expect(
    request.mock.calls.filter(([path]) =>
      String(path).startsWith('/collections?'),
    ),
  ).toHaveLength(1)
  const query = new URL(
    String(request.mock.calls[0]![0]),
    'https://example.test',
  ).searchParams
  expect(query.get('related_to')).toBe('profile')
  expect(query.get('entity_type')).toBe('x.post')
  expect(query.get('sort')).toBe('published')
  // Newest first is the server's default, so the request leaves it out.
  expect(query.get('order')).toBeNull()
  expect(el.querySelector('form')).not.toBeNull()
  expect(el.querySelector('summary[aria-label="作者"]')).toBeNull()
  el.querySelector<HTMLButtonElement>('[aria-label="相册"]')!.click()
  await nextTick()
  expect(
    request.mock.calls.filter(([path]) =>
      String(path).startsWith('/collections?'),
    ),
  ).toHaveLength(1)
  expect(
    el.querySelector('[aria-label="相册"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
})

it('restarts published-time pagination when changing order and preserves the selected layout', async () => {
  let intersect = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = () => callback([{ isIntersecting: true }])
      }
      observe() {}
      disconnect() {}
    },
  )
  const request = mockApi()
  const queries: URLSearchParams[] = []
  request.mockImplementation(async (path) => {
    if (path === '/tags') return []
    if (path.startsWith('/collections/count?')) return { count: 2, types: {} }
    const query = new URL(String(path), 'https://example.test').searchParams
    queries.push(query)
    const order = query.get('order') ?? 'desc'
    const second = query.has('cursor')
    return {
      items: [
        {
          id: `${order}-${second ? 'second' : 'first'}`,
          url: 'https://example.test/post',
          text: `${order} ${second ? '第二页' : '第一页'}`,
          author_name: '合成作者',
          observed_at: '2026-10-01T00:00:00Z',
          published_at: '2026-09-01T00:00:00Z',
          visibility: 'public',
          revision_id: 'r1',
          assets: [],
        },
      ],
      next_cursor: second ? '' : `${order}-next`,
      total_storage_bytes: 4096,
    }
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('desc 第一页'))
  await nextTick()
  intersect()
  await vi.waitFor(() => expect(el.querySelectorAll('.row')).toHaveLength(2))
  expect(queries[1]?.get('cursor')).toBe('desc-next')
  expect(queries[1]?.get('sort')).toBe('published')
  expect(queries[1]?.get('order')).toBeNull()
  el.querySelector<HTMLButtonElement>('[aria-label="相册"]')!.click()
  await nextTick()
  expect(queries).toHaveLength(2)
  const orderSelect = el.querySelector<HTMLSelectElement>(
    '[aria-label="排序方向"]',
  )!
  orderSelect.value = 'asc'
  orderSelect.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(queries).toHaveLength(3))
  expect(queries[2]?.get('order')).toBe('asc')
  expect(queries[2]?.get('sort')).toBe('published')
  expect(queries[2]?.has('cursor')).toBe(false)
  expect(
    el.querySelector('[aria-label="相册"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
  el.querySelector<HTMLButtonElement>('[aria-label="信息流"]')!.click()
  await vi.waitFor(() => expect(el.querySelectorAll('.row')).toHaveLength(1))
  expect(el.textContent).toContain('asc 第一页')
  expect(el.textContent).not.toContain('desc')
  await nextTick()
  intersect()
  await vi.waitFor(() => expect(el.querySelectorAll('.row')).toHaveLength(2))
  expect(queries[3]?.get('cursor')).toBe('asc-next')
  expect(queries[3]?.get('order')).toBe('asc')
})

it('orders posts by when they were added or last updated, dated to match', async () => {
  const request = mockApi()
  const queries: URLSearchParams[] = []
  request.mockImplementation(async (path) => {
    if (path === '/tags') return []
    if (path.startsWith('/collections/count?')) return { count: 2, types: {} }
    queries.push(new URL(String(path), 'https://example.test').searchParams)
    return {
      items: [
        {
          id: 'post',
          url: 'https://example.test/post',
          text: '关联帖子',
          author_name: '作者',
          observed_at: '2024-03-04T12:00:00Z',
          saved_at: '2023-05-06T12:00:00Z',
          published_at: '2022-07-08T12:00:00Z',
          visibility: 'public',
          revision_id: 'r1',
          assets: [],
        },
      ],
      total_storage_bytes: 0,
    }
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('2022年7月8日'))
  const sort = el.querySelector<HTMLSelectElement>('[aria-label="排序"]')!
  expect([...sort.options].map((o) => o.textContent?.trim())).toEqual([
    '发帖时间',
    '添加时间',
    '更新时间',
    '存储空间',
  ])
  sort.value = 'saved'
  sort.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(queries.at(-1)?.get('sort')).toBe('saved'))
  await vi.waitFor(() => expect(el.textContent).toContain('2023年5月6日'))
  sort.value = 'updated'
  sort.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(queries.at(-1)?.get('sort')).toBe('updated'))
  await vi.waitFor(() => expect(el.textContent).toContain('2024年3月4日'))
})
it('offers the posts before the last page read below the whole list', async () => {
  const request = mockApi()
  request.mockResolvedValue({ items: [], total_storage_bytes: 0 })
  const older = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
    older: true,
    onOlder: () => older,
  })
  app.mount(el)
  unmount = () => app.unmount()
  const button = await vi.waitFor(() => {
    const found = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '抓取更早的帖子',
    )
    expect(found).toBeDefined()
    return found!
  })
  button.click()
  expect(older).toHaveBeenCalledOnce()
})

it('shows the total beside the list, counted per filter and not per page', async () => {
  let intersect = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = () => callback([{ isIntersecting: true }])
      }
      observe() {}
      disconnect() {}
    },
  )
  const request = mockApi()
  let answer: (counted: { count: number; types: object }) => void = () => {}
  request.mockImplementation((path) => {
    if (path === '/tags') return []
    if (path.startsWith('/collections/count?')) {
      // Answered by hand: the list must not wait for it.
      const pending = Promise.withResolvers<{ count: number; types: object }>()
      answer = pending.resolve
      return pending.promise
    }
    const query = new URL(String(path), 'https://example.test').searchParams
    const second = query.has('cursor')
    return {
      items: [
        {
          id: `${query.get('q') || 'all'}-${second ? 2 : 1}`,
          url: 'https://example.test/post',
          text: second ? '第二页' : '第一页',
          author_name: '作者',
          observed_at: '2026-10-01T00:00:00Z',
          visibility: 'public',
          revision_id: 'r1',
          assets: [],
        },
      ],
      next_cursor: second ? '' : 'next',
      total_storage_bytes: 0,
    }
  })
  const counts = () =>
    request.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith('/collections/count?'))
      .map((path) => new URLSearchParams(path.split('?', 2)[1]))
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('第一页'))
  // Asked beside the first page; until it answers, nothing stands in.
  expect(counts()).toHaveLength(1)
  expect(counts()[0]!.get('related_to')).toBe('profile')
  expect(counts()[0]!.get('entity_type')).toBe('x.post')
  expect(el.querySelector('.total')).toBeNull()
  answer({ count: 1234, types: { 'x.post': 1234 } })
  await vi.waitFor(() =>
    expect(el.querySelector('.total')?.textContent).toBe('1,234 条'),
  )

  await nextTick()
  intersect()
  await vi.waitFor(() => expect(el.textContent).toContain('第二页'))
  expect(counts()).toHaveLength(1)
  expect(el.querySelector('.total')?.textContent).toBe('1,234 条')

  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="搜索或筛选"]',
  )!
  input.value = 'cat'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  el.querySelector<HTMLButtonElement>('.query .submit')!.click()
  await vi.waitFor(() => expect(counts()).toHaveLength(2))
  expect(counts()[1]!.get('q')).toBe('cat')
  expect(counts()[1]!.has('cursor')).toBe(false)
  // The old filter's total is gone until the new one is counted.
  expect(el.querySelector('.total')).toBeNull()
  answer({ count: 0, types: {} })
  await vi.waitFor(() =>
    expect(el.querySelector('.total')?.textContent).toBe('0 条'),
  )
})
