import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { api } from '../api'
import ProfileCollections from './ProfileCollections.vue'
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))
let unmount = () => {}
it('loads Instagram profile members with their own platform entity type', async () => {
  const request = vi.mocked(api)
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
  const request = vi.mocked(api)
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
  expect(el.textContent).toContain('帖子占用总量 4.0 KB')
  expect(request).toHaveBeenCalledTimes(1)
  const query = new URL(
    String(request.mock.calls[0]![0]),
    'https://example.test',
  ).searchParams
  expect(query.get('related_to')).toBe('profile')
  expect(query.get('entity_type')).toBe('x.post')
  expect(query.get('sort')).toBe('published')
  expect(query.get('order')).toBe('desc')
  expect(el.querySelector('form')).toBeNull()
  el.querySelector<HTMLButtonElement>('[aria-label="相册"]')!.click()
  await nextTick()
  expect(request).toHaveBeenCalledTimes(1)
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
  const request = vi.mocked(api)
  const queries: URLSearchParams[] = []
  request.mockImplementation(async (path) => {
    const query = new URL(String(path), 'https://example.test').searchParams
    queries.push(query)
    const order = query.get('order')
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
  expect(queries[1]?.get('order')).toBe('desc')
  el.querySelector<HTMLButtonElement>('[aria-label="相册"]')!.click()
  await nextTick()
  expect(request).toHaveBeenCalledTimes(2)
  el.querySelector<HTMLButtonElement>('[aria-label^="发布时间排序"]')!.click()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
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
