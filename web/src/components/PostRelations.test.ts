import { afterEach, expect, it } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { asset, collection as collectionOf, entity } from '../testing/api'
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
  const collection = collectionOf({
    id: 'post',
    url: 'https://example.test/post',
    text: '根帖正文',
    observed_at: '2026-10-01T00:00:00Z',
    revision_id: 'r1',
    assets: [],
    graph,
    incoming_relations,
  })
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
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文' },
      }),
    ],
    relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(el.querySelector('.context')?.textContent).toContain('引用了这条帖子')
  expect(link.textContent).not.toContain('引用了这条帖子')
  expect(link.textContent).toContain('引用的原帖正文')
  expect(link.getAttribute('href')).toBe('#/collection/saved-quote')
  expect(link.getAttribute('target')).toBeNull()
  // A saved quote is an indented aside, not a card with its own footer.
  expect(link.textContent).not.toContain('在 X')
  expect(el.querySelector('.destination')).toBeNull()
})
it('shows a quoted post kept by reference with its saved summary, or as an X link', () => {
  const quote = (saved: boolean) =>
    mount({
      root: 'post',
      entities: [
        root,
        entity({
          key: 'quote',
          type: 'x.post',
          external_id: '456',
          ...(saved
            ? {
                saved_collection_id: 'saved-quote',
                saved_summary: '原作者：已保存的原帖',
              }
            : {}),
          data: { text: '' },
        }),
      ],
      relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
    }).querySelector<HTMLAnchorElement>('.relation')!
  const saved = quote(true)
  expect(saved.textContent).toContain('原作者：已保存的原帖')
  expect(saved.getAttribute('href')).toBe('#/collection/saved-quote')
  unmount()
  document.body.replaceChildren()
  const unsaved = quote(false)
  expect(document.querySelector('.context')?.textContent).toContain('在 X')
  expect(unsaved.textContent).toContain('帖子 456')
  expect(unsaved.getAttribute('href')).toBe('https://x.com/i/web/status/456')
})
it('heads a quoted post kept by reference with its saved author', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        saved_text: '已保存的原帖',
        saved_author: {
          key: 'saved_author_0',
          type: 'x.profile',
          external_id: '789',
          saved_collection_id: 'saved-author',
          data: { username: 'quoted_account', name: '原帖作者' },
        },
        data: {},
      }),
    ],
    relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
  })
  const author = el.querySelector<HTMLAnchorElement>('.relation-author')!
  expect(author.getAttribute('href')).toBe('#/collection/saved-author')
  expect(author.textContent).toContain('原帖作者')
  expect(author.textContent).toContain('@quoted_account')
})
it('links an unsaved repost to its X status without using untrusted payload URLs', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'repost',
        type: 'x.post',
        external_id: '456',
        data: { text: '转发的原帖', url: 'javascript:alert(1)' },
      }),
    ],
    relations: [{ source: 'post', target: 'repost', type: 'reposted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(el.querySelector('.context')?.textContent).toContain(
    '转发了这条帖子 · 在 X',
  )
  expect(link.textContent).not.toContain('在 X')
  expect(link.getAttribute('href')).toBe('https://x.com/i/web/status/456')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})
it('shows profile repost attribution without confusing it with a quoted post', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'reposter',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'profile',
        data: { username: 'fixture', name: '转发账号' },
      }),
    ],
    relations: [{ source: 'reposter', target: 'post', type: 'reposted' }],
  })
  const link = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(el.querySelector('.context')?.textContent).toContain('转发此帖的账号')
  expect(link.textContent).toContain('转发账号')
  expect(link.getAttribute('href')).toBe('#/collection/profile')
})
it('does not invent links for invalid identifiers or unrelated graph edges', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'unsafe',
        type: 'x.post',
        external_id: '../unsafe',
        data: {},
      }),
      entity({ key: 'other', type: 'x.post', external_id: '456', data: {} }),
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
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文', published_at: '2026-09-20T12:00:00Z' },
      }),
      entity({
        key: 'quote-author',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'saved-author',
        data: { username: 'quoted_account', name: '被引用账号' },
        assets: [
          asset({
            id: 'avatar-1',
            url: '/v1/assets/avatar-1?inline=1',
            purpose: 'avatar',
            state: 'ready',
            mime: 'image/png',
            sensitive: false,
          }),
        ],
      }),
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
      entity({
        key: 'repost',
        type: 'x.post',
        external_id: '456',
        data: { text: '转发的原帖' },
      }),
      entity({
        key: 'repost-author',
        type: 'x.profile',
        external_id: '789',
        data: { username: 'origin_account' },
      }),
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
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用的原帖正文' },
      }),
      entity({ key: 'blank', type: 'x.profile', external_id: '789', data: {} }),
      entity({
        key: 'other-post',
        type: 'x.post',
        external_id: '567',
        data: {},
      }),
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
  expect(el.querySelector('.context')?.textContent).toContain(
    '这条帖子引用了当前帖子',
  )
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
  expect(el.querySelector('.context')?.textContent).toContain('转发此帖的账号')
  expect(el.querySelector('.relation-author')).toBeNull()
})
it('shows a repost account card with its own saved avatar, never a sensitive one', () => {
  const avatar = (sensitive: boolean) =>
    asset({
      id: sensitive ? 'hidden-avatar' : 'avatar',
      url: `/v1/assets/${sensitive ? 'hidden-avatar' : 'avatar'}?inline=1`,
      purpose: 'avatar',
      mime: 'image/png',
      state: 'ready',
      sensitive,
    })
  const profile = (key: string, sensitive: boolean) =>
    entity({
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
  // The account reads like a quoted post's author: avatar, name, handle.
  const account = shown?.querySelector('.account')
  expect(account?.querySelector('img.avatar')?.getAttribute('src')).toBe(
    '/v1/assets/avatar?inline=1',
  )
  expect(account?.querySelector('.author-name')?.textContent).toBe(
    '合成账号 shown',
  )
  expect(account?.querySelector('.author-handle')?.textContent).toBe('@shown')
  // Without a shown avatar the row simply starts with the name.
  expect(hidden?.querySelector('img')).toBeNull()
  expect(hidden?.querySelector('.account')?.textContent).toContain(
    '合成账号 hidden',
  )
  expect(el.querySelector('.relation-author')).toBeNull()
  expect(el.querySelector('.thumbs-group')).toBeNull()
})
it('shows the reposting account as captured or as last seen, with its lock', async () => {
  const avatar = (id: string) =>
    asset({
      id,
      url: `/v1/assets/${id}?inline=1`,
      purpose: 'avatar',
      mime: 'image/png',
      sha256: id,
    })
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'reposter',
        type: 'x.profile',
        external_id: '789',
        saved_collection_id: 'profile',
        data: { username: 'old', name: '旧名字' },
        assets: [avatar('old-avatar')],
        current: {
          id: 'v2',
          data: {
            username: 'renamed',
            name: '新名字',
            metadata: { protected: true },
          },
          assets: [avatar('new-avatar')],
        },
      }),
    ],
    relations: [{ source: 'reposter', target: 'post', type: 'reposted' }],
  })
  const account = () => el.querySelector('.relation .account')!
  expect(account().textContent).toContain('新名字')
  expect(account().textContent).toContain('@renamed')
  expect(account().querySelector('.lock')).not.toBeNull()
  expect(account().querySelector('img')?.getAttribute('src')).toBe(
    '/v1/assets/new-avatar?inline=1',
  )
  el.querySelector<HTMLButtonElement>('.profile-version')!.click()
  await nextTick()
  expect(account().textContent).toContain('旧名字')
  expect(account().textContent).toContain('@old')
  expect(account().querySelector('.lock')).toBeNull()
  expect(account().querySelector('img')?.getAttribute('src')).toBe(
    '/v1/assets/old-avatar?inline=1',
  )
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
  const contexts = [...el.querySelectorAll('.context')].map(
    (c) => c.textContent,
  )
  expect(contexts[0]).toContain('转发此帖的账号')
  expect(contexts[1]).toContain('这条帖子引用了当前帖子')
  expect(contexts[2]).toContain('这条帖子转发了当前帖子')
  expect(links[0]?.getAttribute('href')).toBe('#/collection/saved-profile')
  expect(links[1]?.getAttribute('href')).toBe('#/collection/saved-quote')
  expect(links[2]?.getAttribute('href')).toBe('https://x.com/i/web/status/567')
})
it('shows a quoted post’s author as last seen, with its lock', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        data: { text: '锁推原帖' },
      }),
      entity({
        key: 'author',
        type: 'x.profile',
        external_id: '789',
        data: { name: '旧名字', metadata: { protected: false } },
        current: {
          id: 'v2',
          data: { name: '新名字', metadata: { protected: true } },
        },
      }),
    ],
    relations: [
      { source: 'post', target: 'quote', type: 'quoted' },
      { source: 'quote', target: 'author', type: 'authored_by' },
    ],
  })
  expect(el.querySelector('.relation-author')!.textContent).toContain('新名字')
  expect(el.querySelector('.relation-author .lock')).not.toBeNull()
})

it('shows saved quote media inside its card without mixing it into the root gallery', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'quote',
        type: 'x.post',
        external_id: '456',
        saved_collection_id: 'saved-quote',
        data: { text: '引用正文' },
        assets: [
          asset({
            id: 'quoted-image',
            url: '/v1/assets/quoted-image?inline=1',
            state: 'ready',
            mime: 'image/png',
            sensitive: false,
          }),
        ],
      }),
    ],
    relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
  })
  expect(el.querySelector('.relations img')?.getAttribute('src')).toBe(
    '/v1/assets/quoted-image?inline=1',
  )
  expect(el.querySelector('.post > .media-group')).toBeNull()
  expect(el.querySelector('.context')?.textContent).toContain('引用了这条帖子')
  expect(el.querySelector('.quote')?.textContent).not.toContain(
    '引用了这条帖子',
  )
})
it('shares one context line between consecutive relations of the same kind', () => {
  const el = mount({
    root: 'post',
    entities: [
      root,
      entity({
        key: 'a',
        type: 'x.post',
        external_id: '1',
        data: { text: '甲' },
      }),
      entity({
        key: 'b',
        type: 'x.post',
        external_id: '2',
        data: { text: '乙' },
      }),
    ],
    relations: [
      { source: 'post', target: 'a', type: 'quoted' },
      { source: 'post', target: 'b', type: 'quoted' },
    ],
  })
  expect(el.querySelectorAll('.context')).toHaveLength(1)
  expect(el.querySelectorAll('.quote')).toHaveLength(2)
})
