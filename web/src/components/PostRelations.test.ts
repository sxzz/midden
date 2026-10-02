import { afterEach, expect, it } from 'vitest'
import { createVaporApp } from 'vue'
import CollectionPost from './CollectionPost.vue'
import type { Collection } from '../api'

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})
function mount(
  graph: NonNullable<Collection['graph']>,
  incoming_relations?: Collection['incoming_relations'],
) {
  const collection: Collection = {
    id: 'post',
    url: 'https://example.test/post',
    text: '根帖正文',
    observed_at: '2026-10-01T00:00:00Z',
    visibility: 'public',
    revision_id: 'r1',
    assets: [],
    graph,
    incoming_relations,
  }
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionPost, { collection })
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const root = { key: 'post', type: 'x.post', external_id: '123', data: {} }
it('shows the quoted post as an internal collection link with its text', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文' },
      },
    ],
    relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(link.textContent).toContain('引用的帖子')
  expect(link.textContent).toContain('引用的原帖正文')
  expect(link.getAttribute('href')).toBe('#/collection/saved-quote')
  expect(link.getAttribute('target')).toBeNull()
  // A saved quote is an indented aside, not a card with its own footer.
  expect(link.textContent).not.toContain('在 X')
  expect(el.querySelector('.destination')).toBeNull()
})
it('links an unsaved repost to its X status without using untrusted payload URLs', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'repost',
        type: 'x.post',
        external_id: '456',
        data: { text: '转发的原帖', url: 'javascript:alert(1)' },
      },
    ],
    relations: [{ source: 'post', target: 'repost', type: 'reposted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(link.textContent).toContain('转发的帖子')
  expect(link.textContent).toContain('在 X')
  expect(link.getAttribute('href')).toBe('https://x.com/i/web/status/456')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})
it('shows profile repost attribution without confusing it with a quoted post', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'reposter',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'profile',
        data: { username: 'fixture', name: '转发账号' },
      },
    ],
    relations: [{ source: 'reposter', target: 'post', type: 'reposted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(link.textContent).toContain('转发此帖的账号')
  expect(link.textContent).toContain('转发账号')
  expect(link.getAttribute('href')).toBe('#/collection/profile')
})
it('does not invent links for invalid identifiers or unrelated graph edges', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'unsafe',
        type: 'x.post',
        external_id: '../unsafe',
        data: {},
      },
      { key: 'other', type: 'x.post', external_id: '456', data: {} },
    ],
    relations: [
      { source: 'post', target: 'unsafe', type: 'quoted' },
      { source: 'other', target: 'unsafe', type: 'quoted' },
      { source: 'post', target: 'other', type: 'mentions' },
    ],
  })
  expect(el.querySelector('.relations')).toBeNull()
})

it('heads an outgoing quote with its graph author, avatar and date, linking the saved profile beside the post', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文', published_at: '2026-09-20T12:00:00Z' },
      },
      {
        key: 'quote-author',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'saved-author',
        data: { username: 'quoted_account', name: '被引用账号' },
        assets: [
          {
            id: 'avatar-1',
            purpose: 'avatar',
            state: 'ready',
            mime: 'image/png',
            sensitive: false,
          },
        ],
      },
    ],
    relations: [
      { source: 'post', target: 'quote', type: 'quoted' },
      { source: 'quote', target: 'quote-author', type: 'authored_by' },
    ],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(link.getAttribute('href')).toBe('#/collection/saved-quote')
  const author = el.querySelector<HTMLAnchorElement>('.relation-author')!
  expect(author.tagName).toBe('A')
  expect(author.getAttribute('href')).toBe('#/collection/saved-author')
  expect(author.textContent).toContain('被引用账号')
  expect(author.textContent).toContain('@quoted_account')
  // Avatars come from assets already saved here, never from a remote source.
  expect(author.querySelector('img')?.getAttribute('src')).toBe(
    '/v1/assets/avatar-1?inline=1',
  )
  const published = el.querySelector<HTMLTimeElement>('.published')!
  expect(published.getAttribute('datetime')).toBe('2026-09-20T12:00:00Z')
  expect(published.textContent).toMatch(/9月\d+日/)
  // The post link and the profile link are siblings, never nested anchors.
  expect(link.querySelector('a')).toBeNull()
  expect(author.closest('.relation')).toBeNull()
  expect(author.closest('.quote')).toBe(link.closest('.quote'))
  // The block is marked by its rule alone, with no enclosing card element.
  expect(el.querySelector('.relation-card')).toBeNull()
})
it('shows an unsaved outgoing repost author as plain text instead of a link', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'repost',
        type: 'x.post',
        external_id: '456',
        data: { text: '转发的原帖' },
      },
      {
        key: 'repost-author',
        type: 'x.profile',
        external_id: '789',
        data: { username: 'origin_account' },
      },
    ],
    relations: [
      { source: 'post', target: 'repost', type: 'reposted' },
      { source: 'repost', target: 'repost-author', type: 'authored_by' },
    ],
  })
  const author = el.querySelector<HTMLElement>('.relation-author')!
  expect(author.tagName).toBe('SPAN')
  expect(author.textContent).toContain('@origin_account')
  expect(el.querySelectorAll('a')).toHaveLength(1)
})
it('omits attribution when the snapshot records no usable author', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文' },
      },
      { key: 'blank', type: 'x.profile', external_id: '789', data: {} },
      { key: 'other-post', type: 'x.post', external_id: '567', data: {} },
    ],
    relations: [
      { source: 'post', target: 'quote', type: 'quoted' },
      { source: 'quote', target: 'missing', type: 'authored_by' },
      { source: 'other-post', target: 'blank', type: 'authored_by' },
    ],
  })
  expect(el.querySelector('.relation')).not.toBeNull()
  expect(el.querySelector('.relation-author')).toBeNull()
})
it('attributes an incoming quote to the author the relation supplies', () => {
  const el = mount({ root: 'post', entities: [root], relations: [] }, [
    {
      type: 'quoted',
      entity: {
        key: 'source-quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '合成引用内容', published_at: '2026-09-25T12:00:00Z' },
      },
      author: {
        key: 'source-author',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'saved-author',
        data: { username: 'quoting_account', name: '引用此帖的账号' },
      },
    },
  ])
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(link.textContent).toContain('引用此帖的帖子')
  expect(link.textContent).toContain('合成引用内容')
  const author = el.querySelector<HTMLAnchorElement>('.relation-author')!
  expect(author.getAttribute('href')).toBe('#/collection/saved-author')
  expect(author.textContent).toContain('引用此帖的账号')
  expect(author.textContent).toContain('@quoting_account')
  // No avatar was saved for this author, so the header simply omits one.
  expect(author.querySelector('img')).toBeNull()
  expect(el.querySelector('.published')?.getAttribute('datetime')).toBe(
    '2026-09-25T12:00:00Z',
  )
  expect(link.querySelector('a')).toBeNull()
})
it('keeps an incoming repost account card free of a repeated self attribution', () => {
  const profile = {
    key: 'reposter',
    type: 'x.profile',
    external_id: '789',
    saved_collection_id: 'saved-profile',
    data: { username: 'fixture', name: '合成转发账号' },
  }
  const el = mount({ root: 'post', entities: [root], relations: [] }, [
    { type: 'reposted', entity: profile, author: profile },
  ])
  expect(el.querySelector('.relation')?.textContent).toContain('转发此帖的账号')
  expect(el.querySelector('.relation-author')).toBeNull()
})
it('shows a repost account card with its own saved avatar, never a sensitive one', () => {
  const avatar = (sensitive: boolean) => ({
    id: sensitive ? 'hidden-avatar' : 'avatar',
    purpose: 'avatar',
    state: 'ready',
    sensitive,
  })
  const profile = (key: string, sensitive: boolean) => ({
    key,
    type: 'x.profile',
    external_id: key === 'shown' ? '789' : '790',
    saved_collection_id: `saved-${key}`,
    data: { username: key, name: `合成账号 ${key}` },
    assets: [avatar(sensitive)],
  })
  const el = mount({ root: 'post', entities: [root], relations: [] }, [
    { type: 'reposted', entity: profile('shown', false) },
    { type: 'reposted', entity: profile('hidden', true) },
  ])
  const [shown, hidden] = el.querySelectorAll('.relation')
  expect(shown?.querySelector('img')?.getAttribute('src')).toBe(
    '/v1/assets/avatar?inline=1',
  )
  expect(shown?.textContent).toContain('合成账号 shown')
  expect(hidden?.querySelector('img')).toBeNull()
  expect(hidden?.textContent).toContain('合成账号 hidden')
  expect(el.querySelector('.relation-author')).toBeNull()
})
it('shows saved incoming repost accounts and quote/repost posts without duplicate snapshot cards', () => {
  const profile = {
    key: 'reposter',
    type: 'x.profile',
    external_id: '789',
    data: { name: '合成转发账号' },
  }
  const el = mount(
    {
      root: 'post',
      entities: [root, profile],
      relations: [{ source: 'reposter', target: 'post', type: 'reposted' }],
    },
    [
      {
        type: 'reposted',
        entity: {
          ...profile,
          key: 'live-profile',
          saved_collection_id: 'saved-profile',
        },
      },
      {
        type: 'quoted',
        entity: {
          key: 'source-quote',
          type: 'x.post',
          external_id: '456',
          saved_collection_id: 'saved-quote',
          data: { text: '合成引用内容' },
        },
      },
      {
        type: 'reposted',
        entity: {
          key: 'source-repost',
          type: 'x.post',
          external_id: '567',
          data: { text: '合成转发内容' },
        },
      },
    ],
  )
  const links = [...el.querySelectorAll<HTMLAnchorElement>('.relation')]
  expect(links).toHaveLength(3)
  expect(links[0]?.textContent).toContain('转发此帖的账号')
  expect(links[0]?.getAttribute('href')).toBe('#/collection/saved-profile')
  expect(links[1]?.textContent).toContain('引用此帖的帖子')
  expect(links[1]?.getAttribute('href')).toBe('#/collection/saved-quote')
  expect(links[2]?.textContent).toContain('转发此帖的帖子')
  expect(links[2]?.getAttribute('href')).toBe('https://x.com/i/web/status/567')
})
it('shows a quoted post’s author as last seen, with its lock', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      {
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        data: { text: '锁推原帖' },
      },
      {
        key: 'author',
        type: 'x.profile',
        external_id: '789',
        data: { name: '旧名字', metadata: { protected: false } },
        current: {
          id: 'v2',
          data: { name: '新名字', metadata: { protected: true } },
        },
      },
    ],
    relations: [
      { source: 'post', target: 'quote', type: 'quoted' },
      { source: 'quote', target: 'author', type: 'authored_by' },
    ],
  })
  expect(el.querySelector('.relation-author')!.textContent).toContain('新名字')
  expect(el.querySelector('.relation-author .lock')).not.toBeNull()
})
