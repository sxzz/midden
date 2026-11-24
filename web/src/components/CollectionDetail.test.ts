import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { shareSlug } from '../share'
import { collection, mockApi } from '../testing/api'
import CollectionDetail from './CollectionDetail.vue'
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  shareSlug.value = ''
  vi.unstubAllGlobals()
})

const profile = collection({
  id: 'profile',
  url: 'https://x.com/i/user/1',
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '1',
        data: { name: '合成账号', username: 'synthetic', metadata: {} },
      },
    ],
  },
})

async function mount() {
  mockApi((path) => {
    if (
      path === '/collections/profile' ||
      path === '/public/s/collections/profile'
    )
      return profile
    if (path.endsWith('/availability')) return { available: true }
    if (path === '/captures')
      return {
        id: 'job',
        collection_id: 'profile',
        state: 'queued',
        record_id: 'record',
      }
    if (path.startsWith('/shares')) return []
    if (path.endsWith('/annotation')) return { tags: [], note: '' }
    if (path.startsWith('/tags')) return []
    if (path.includes('/collections?') || path.includes('/history'))
      return { items: [] }
    return {}
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionDetail, { id: 'profile' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('合成账号'))
  return el
}

/** Each list group's rows, by the text that starts them. */
const groups = (el: HTMLElement) =>
  [...el.querySelectorAll('.section-body')].map((body) =>
    [...body.querySelectorAll(':scope > button, :scope > a, :scope > label')]
      .map((row) => row.textContent?.trim().replace(/›$/, '').trim())
      .filter(Boolean),
  )

it('puts 抓关系网, 重新抓取 and 查看进度 in a list group of their own', async () => {
  const el = await mount()
  await vi.waitFor(() =>
    expect(groups(el)).toContainEqual([
      '抓关系网更新时一并抓取关注和粉丝列表',
      '重新抓取',
    ]),
  )
  const update = el.querySelector<HTMLElement>('.update .section-body')!
  ;[...update.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === '重新抓取')!
    .click()
  // The progress of the update started here joins the same group.
  await vi.waitFor(() => expect(update.textContent).toContain('查看进度'))
  // The switch comes first, right above the button that starts the update.
  expect(
    update.firstElementChild?.querySelector('[role=switch]'),
  ).not.toBeNull()
  // Opening the original, sharing and deleting are elsewhere.
  for (const other of ['打开原文', '公开分享', '删除这条收藏']) {
    expect(update.textContent).not.toContain(other)
    expect(el.textContent).toContain(other)
  }
})

it('shows no update group behind a public link', async () => {
  shareSlug.value = 's'
  const el = await mount()
  expect(el.querySelector('.update')).toBeNull()
  expect(el.querySelector('[role=switch]')).toBeNull()
  expect(el.textContent).not.toContain('重新抓取')
  expect(el.textContent).toContain('打开原文')
})
