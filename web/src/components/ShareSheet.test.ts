import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { APIError, type Share } from '../api'
import { router } from '../router'
import { collection, entity, mockApi, type Request } from '../testing/api'
import CollectionLibrary from './CollectionLibrary.vue'

const ID = '00000000-0000-7000-8000-000000000001'
const FOLDER = '00000000-0000-7000-8000-00000000000f'
const SHARE = '00000000-0000-7000-8000-0000000000aa'
const SLUG = 'AbCdEfGhIjKlMnOpQrStUv_-'
// The app's own address with the share's route: / when built.
const LINK = `${location.origin}${import.meta.env.BASE_URL}s/${SLUG}`
const RANDOM = 'ZyXwVuTsRqPoNmLkJiHgFeDc'
const linkTo = (slug: string) =>
  `${location.origin}${import.meta.env.BASE_URL}s/${slug}`

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
      slug: 'Folder_Slug_000000000000',
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
    if (path.startsWith('/shares/') && request.method === 'PATCH') {
      const { slug } = JSON.parse((request as Request).body!) as {
        slug: string | null
      }
      if (slug === 'taken')
        throw new APIError(409, '这个链接已被其他公开分享使用')
      shares = shares.map((s) =>
        s.id === path.slice(8) ? { ...s, slug: slug ?? RANDOM } : s,
      )
      return shares.find((s) => s.id === path.slice(8))
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
      `${location.origin}${import.meta.env.BASE_URL}s/Folder_Slug_000000000000`,
    ),
  )
  expect(button(sheet, '取消公开')).toBeTruthy()
})

it('sets a custom link, checking it as typed, and goes back to random', async () => {
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
  const custom = () =>
    [...sheet.querySelectorAll('label')].find(
      (label) => label.textContent?.trim() === '自定义链接',
    )!.control as HTMLInputElement
  await vi.waitFor(() => expect(custom()).toBeTruthy())
  // A random link has no custom slug to show, nor one to go back from.
  expect(custom().value).toBe('')
  expect(button(sheet, '改回随机链接')).toBeUndefined()
  const save = () => button(sheet, '保存')
  expect(save().disabled).toBe(true)
  const type = async (value: string) => {
    custom().value = value
    custom().dispatchEvent(new Event('input'))
    await nextTick()
  }
  const hint = () => sheet.querySelector('.hint')?.textContent?.trim()

  for (const [value, message] of [
    ['My-Picks', '只能用小写字母、数字和 -'],
    ['ab', '至少3个字符'],
    ['-picks', '不能以 - 开头或结尾'],
    ['x'.repeat(65), '最多64个字符'],
  ] as const) {
    await type(value)
    expect(hint()).toBe(message)
    expect(custom().getAttribute('aria-invalid')).toBe('true')
    expect(save().disabled).toBe(true)
  }

  // Taken by another live link: the server says so beside the field.
  await type('taken')
  expect(save().disabled).toBe(false)
  save().click()
  await vi.waitFor(() => expect(hint()).toBe('这个链接已被其他公开分享使用'))

  await type('my-picks')
  save().click()
  await vi.waitFor(() =>
    expect(sheet.querySelector('input')?.value).toBe(linkTo('my-picks')),
  )
  expect(sent('PATCH', `/shares/${shares[0]!.id}`)).toEqual([
    { slug: 'taken' },
    { slug: 'my-picks' },
  ])
  expect(custom().value).toBe('my-picks')
  expect(save().disabled).toBe(true)

  button(sheet, '改回随机链接').click()
  await vi.waitFor(() =>
    expect(sheet.querySelector('input')?.value).toBe(linkTo(RANDOM)),
  )
  expect(sent('PATCH', `/shares/${shares[0]!.id}`).at(-1)).toEqual({
    slug: null,
  })
  expect(custom().value).toBe('')
  expect(button(sheet, '改回随机链接')).toBeUndefined()
  expect(button(sheet, '复制链接')).toBeTruthy()
  expect(button(sheet, '取消公开')).toBeTruthy()
})
