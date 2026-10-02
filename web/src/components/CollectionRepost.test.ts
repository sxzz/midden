import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { api, type Collection } from '../api'
import CollectionRow from './CollectionRow.vue'
import ProfileCollections from './ProfileCollections.vue'
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))
/** A post someone else wrote, kept because the listed account reposted it. */
const repost: Collection = {
  id: 'repost',
  url: 'https://example.test/post/1',
  text: '合成原帖正文',
  author_name: '合成原作者',
  observed_at: '2026-10-01T00:00:00Z',
  saved_at: '2026-10-01T00:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  relation_types: ['reposted'],
  assets: [],
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '100', data: {} },
      {
        key: 'author',
        type: 'x.profile',
        external_id: '200',
        data: { username: 'origin', name: '合成原作者' },
      },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
}
const mentioned: Collection = {
  ...repost,
  id: 'mentioned',
  relation_types: ['mentions'],
}
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
})
function mount(
  component: Parameters<typeof createVaporApp>[0],
  props: Record<string, unknown>,
) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(component, props)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const line = (el: Element) =>
  el.querySelector('.repost')?.textContent?.replaceAll(/\s+/g, ' ').trim()
it('puts the repost line on its own row above the whole original post', () => {
  const el = mount(CollectionRow, {
    collection: repost,
    repostedBy: '合成收藏账号',
  })
  expect(line(el)).toBe('合成收藏账号 已转发')
  const banner = el.querySelector('.repost')!
  expect(banner.querySelector('svg')).not.toBeNull()
  // The line is the row's own text, not a card of its own around the post.
  expect(banner.closest('a, button')).toBeNull()
  // It precedes the avatar as well as the name: both begin below it.
  const post = el.querySelector('.post')!
  expect(banner.parentElement).toBe(el.querySelector('.row'))
  expect(post.contains(banner)).toBe(false)
  expect(
    banner.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(post.querySelector('.initials')?.textContent).toBe('合')
  // Everything the original author owns stays exactly where it was.
  expect(el.querySelector('.name')?.textContent).toBe('合成原作者')
  expect(el.querySelector('.preview')?.textContent).toBe('合成原帖正文')
  expect(el.querySelector('.when')?.textContent).toBeTruthy()
  // The banner says it, so the row does not repeat it as metadata.
  expect(el.querySelector('.meta')).toBeNull()
})
it('leaves a row without a reposted relation alone, however its author reads', () => {
  const el = mount(CollectionRow, {
    collection: mentioned,
    repostedBy: '合成收藏账号',
  })
  expect(el.querySelector('.repost')).toBeNull()
  expect(el.textContent).not.toContain('已转发')
  expect(el.querySelector('.name')?.textContent).toBe('合成原作者')
})
it('says nothing about a reposter in a list that belongs to no account', () => {
  const el = mount(CollectionRow, { collection: repost })
  expect(el.querySelector('.repost')).toBeNull()
  expect(el.querySelector('.meta')?.textContent).toContain('转发')
})
it('reads the handle beside the name, keeps the time right and drops media counts', () => {
  const el = mount(CollectionRow, {
    collection: {
      ...repost,
      storage_bytes: 2048,
      assets: [
        { id: 'a1', state: 'ready', mime: 'image/png', sensitive: false },
      ],
    },
  })
  const head = el.querySelector('.head')!
  expect(head.querySelector('.name')?.textContent).toBe('合成原作者')
  expect(head.querySelector('.handle')?.textContent).toBe('@origin')
  // Name and handle share one column; the time closes the same header row.
  expect(
    head.querySelector('.identity')?.contains(head.querySelector('.name')!),
  ).toBe(true)
  expect(head.lastElementChild?.className).toContain('when')
  expect(el.textContent).not.toContain('张图片')
  const storage = el.querySelector('.storage')!
  expect(storage.textContent).toBe('2.0 KB')
  // Storage closes the row below the media instead of sitting over it.
  expect(el.querySelector('.content')?.lastElementChild).toBe(storage)
})
it('shows a profile row with its own bio', () => {
  const el = mount(CollectionRow, {
    collection: {
      id: 'profile',
      url: 'https://example.test/profile',
      text: '合成账号简介',
      author_name: '合成账号',
      observed_at: '2026-10-01T00:00:00Z',
      visibility: 'public',
      revision_id: 'r1',
      assets: [],
      graph: {
        root: 'profile',
        entities: [
          {
            key: 'profile',
            type: 'x.profile',
            external_id: '300',
            data: { username: 'synthetic' },
          },
        ],
        relations: [],
      },
    } satisfies Collection,
  })
  expect(el.querySelector('.name')?.textContent).toBe('合成账号')
  expect(el.querySelector('.handle')?.textContent).toBe('@synthetic')
  expect(el.querySelector('.preview')?.textContent).toBe('合成账号简介')
})
it('hands the profile name down to the rows of its related collections', async () => {
  vi.mocked(api).mockResolvedValue({ items: [repost, mentioned] })
  const el = mount(ProfileCollections, {
    id: 'profile',
    revisionId: 'r1',
    repostedBy: '合成收藏账号',
  })
  await vi.waitFor(() => expect(el.querySelectorAll('.row')).toHaveLength(2))
  const rows = [...el.querySelectorAll('.row')]
  expect(rows.map((row) => line(row))).toEqual([
    '合成收藏账号 已转发',
    undefined,
  ])
})
