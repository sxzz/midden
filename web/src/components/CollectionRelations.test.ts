import { afterEach, expect, it } from 'vitest'
import { createVaporApp } from 'vue'
import CollectionAlbum from './CollectionAlbum.vue'
import CollectionRow from './CollectionRow.vue'
import type { Collection } from '../api'
const collection: Collection = {
  id: 'root',
  url: 'https://example.test/post',
  text: '根帖自己的内容',
  observed_at: '2026-10-01T00:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  relation_types: ['reposted', 'mentions'],
  assets: [1, 2].map((id) => ({
    id: `asset-${id}`,
    state: 'ready',
    mime: 'image/png',
    sensitive: false,
  })),
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '100', data: {} },
      {
        key: 'quote',
        type: 'x.post',
        external_id: '200',
        saved_collection_id: 'quote',
        data: {
          text: '被引用帖的独立内容',
          published_at: '2026-09-18T12:00:00Z',
        },
      },
      {
        key: 'quote-author',
        type: 'x.profile',
        external_id: '400',
        saved_collection_id: 'quote-author',
        data: { username: 'quoted_account', name: '被引用账号' },
        assets: [
          {
            id: 'quote-avatar',
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
  },
  incoming_relations: [
    {
      type: 'quoted',
      entity: {
        key: 'unrelated',
        type: 'x.post',
        external_id: '300',
        data: { text: '不要在列表展示的反向引用' },
      },
    },
  ],
}
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
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
it('preserves root text while showing a compact quote and direct relation labels in the feed', () => {
  const el = mount(CollectionRow, { collection })
  expect(el.querySelector('.preview')?.textContent).toBe('根帖自己的内容')
  expect(el.querySelector('.meta')?.textContent).toContain('转发 · 提及')
  const quote = el.querySelector<HTMLAnchorElement>('.relation')!
  expect(quote.textContent).toContain('引用的帖子')
  expect(quote.textContent).toContain('被引用帖的独立内容')
  expect(quote.getAttribute('href')).toBe('#/collection/quote')
  expect(quote.closest('button')).toBeNull()
  expect(el.textContent).not.toContain('不要在列表展示的反向引用')
})
it('heads the compact quote with its author and keeps that profile separately clickable', () => {
  const el = mount(CollectionRow, { collection })
  const quote = el.querySelector<HTMLAnchorElement>('.relation')!
  const author = el.querySelector<HTMLAnchorElement>('.relation-author')!
  expect(author.tagName).toBe('A')
  expect(author.getAttribute('href')).toBe('#/collection/quote-author')
  expect(author.textContent).toContain('被引用账号')
  expect(author.textContent).toContain('@quoted_account')
  expect(author.querySelector('img')?.getAttribute('src')).toBe(
    '/v1/assets/quote-avatar?inline=1',
  )
  expect(el.querySelector('.published')?.getAttribute('datetime')).toBe(
    '2026-09-18T12:00:00Z',
  )
  // Compact rows keep the same two separate links and no enclosing card.
  expect(quote.querySelector('a')).toBeNull()
  expect(author.closest('button')).toBeNull()
  expect(el.querySelector('.relations.compact .quote')).not.toBeNull()
})
it('adds a compact relation caption only to the first media tile, retaining every original asset', () => {
  const el = mount(CollectionAlbum, {
    items: [collection],
    mediaTypes: '',
    loading: false,
    next: '',
    error: '',
  })
  expect(el.querySelectorAll('.tile')).toHaveLength(2)
  expect(el.querySelectorAll('.caption')).toHaveLength(1)
  expect(el.querySelector('.caption-text')?.textContent).toBe('根帖自己的内容')
  expect(el.querySelector('.relation-label')?.textContent).toBe('转发 · 提及')
  expect(el.querySelector('.quote')?.textContent).toContain(
    '被引用帖的独立内容',
  )
  expect(el.querySelector('.quote-author')?.textContent).toContain('被引用账号')
  expect(el.querySelector('.caption')?.getAttribute('title')).toContain(
    '被引用账号 @quoted_account：被引用帖的独立内容',
  )
  expect(el.textContent).not.toContain('不要在列表展示的反向引用')
})
