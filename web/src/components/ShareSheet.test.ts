import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { router } from '../router'
import { collection, entity, mockApi, type Request } from '../testing/api'
import CollectionLibrary from './CollectionLibrary.vue'
import type { Share } from '../api'

const ID = '00000000-0000-7000-8000-000000000001'
const FOLDER = '00000000-0000-7000-8000-00000000000f'
const SHARE = '00000000-0000-7000-8000-0000000000aa'
const SLUG = 'AbCdEfGhIjKlMnOpQrStUv_-'
// The app's own address with the share's route: /app/ when built.
const LINK = `${location.origin}${import.meta.env.BASE_URL}#/s/${SLUG}`

let shares: Share[] = []
let api: ReturnType<typeof mockApi>
const sent = (method: string, path: string) =>
  api.mock.calls
    .filter(([p, r]) => r.method === method && p === path)
    .map(([, r]) => JSON.parse((r as Request).body ?? 'null'))

const post = collection({
  id: ID,
  text: '帖子',
  graph: {
    root: 'root',
    entities: [entity({ key: 'root', type: 'x.post' })],
    relations: [],
  },
})

beforeEach(() => {
  vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {})
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
  shares = [
    {
      id: '00000000-0000-7000-8000-0000000000ff',
      slug: 'folder-slug-000000000000',
      target: 'folder',
      target_id: FOLDER,
      name: '精选',
      created_at: '2026-11-01T00:00:00.000Z',
    },
  ]
  api = mockApi((path, request) => {
    if (path === '/shares' && request.method === 'POST') {
      const made: Share = {
        id: SHARE,
        slug: SLUG,
        target: 'collection',
        target_id: ID,
        created_at: '2026-11-02T00:00:00.000Z',
      }
      shares = [...shares, made]
      return made
    }
    if (path.startsWith('/shares/') && request.method === 'DELETE') {
      shares = shares.filter((s) => s.id !== path.slice(8))
      return
    }
    // Every share here reaches the post.
    if (path.startsWith('/shares')) return shares
    if (path === `/collections/${ID}`) return post
    if (path.endsWith('/history')) return { items: [] }
    if (path.endsWith('/availability')) return { available: true }
    if (path.endsWith('/annotation')) return { note: '', tags: [] }
    if (path.includes('/counts')) return { points: [] }
    if (path === '/folders')
      return [
        {
          id: FOLDER,
          name: '精选',
          filter: 'entity_type=x.post%2Cinstagram.post&q=a',
          count: 1,
          created_at: '2026-11-01T00:00:00.000Z',
          updated_at: '2026-11-01T00:00:00.000Z',
        },
      ]
    if (path === '/tags') return []
    if (path.startsWith('/collections')) return { items: [] }
    return { used_bytes: 0 }
  })
})
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  location.hash = '/'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(path: string) {
  location.hash = path
  await router.push(path)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionLibrary).use(vaporInteropPlugin).use(router)
  await router.isReady()
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const button = (el: ParentNode, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  )!

it('shares a collection, copies its link and stops it, saying how it is public', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const el = await mount(`/collection/${ID}`)
  await vi.waitFor(() =>
    expect(button(el, '公开分享')?.textContent).toContain(
      '已随收藏夹「精选」公开',
    ),
  )
  expect(button(el, '公开分享').textContent).not.toContain('已公开')

  button(el, '公开分享').click()
  await nextTick()
  const sheet = el.querySelector('dialog[open]')!
  await vi.waitFor(() =>
    expect(button(sheet, '创建公开链接')?.disabled).toBe(false),
  )
  button(sheet, '创建公开链接').click()
  await vi.waitFor(() => expect(sheet.querySelector('input')?.value).toBe(LINK))
  expect(sent('POST', '/shares')).toEqual([{ target: 'collection', id: ID }])
  await vi.waitFor(() =>
    expect(button(el, '公开分享').textContent).toContain('已公开'),
  )

  button(sheet, '复制链接').click()
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))

  button(sheet, '取消公开').click()
  await vi.waitFor(() => expect(button(sheet, '创建公开链接')).toBeTruthy())
  expect(
    api.mock.calls.some(
      ([p, r]) => p === `/shares/${SHARE}` && r.method === 'DELETE',
    ),
  ).toBe(true)
  await vi.waitFor(() =>
    expect(button(el, '公开分享').textContent).not.toContain('已公开'),
  )
})

it('shares a folder from its menu, showing the link it already has', async () => {
  const el = await mount(
    `/folder/${FOLDER}?entity_type=x.post%2Cinstagram.post&q=a`,
  )
  await vi.waitFor(() =>
    expect(el.querySelector('h1')?.textContent).toBe('精选'),
  )
  el.querySelector<HTMLButtonElement>('[aria-label="管理收藏夹"]')!.click()
  await nextTick()
  button(el.querySelector('dialog[open]')!, '公开分享').click()
  await nextTick()
  const sheet = el.querySelector('dialog[open]')!
  expect(sheet.textContent).toContain('公开分享收藏夹「精选」')
  await vi.waitFor(() =>
    expect(sheet.querySelector('input')?.value).toBe(
      `${location.origin}${import.meta.env.BASE_URL}#/s/folder-slug-000000000000`,
    ),
  )
  expect(button(sheet, '取消公开')).toBeTruthy()
})
