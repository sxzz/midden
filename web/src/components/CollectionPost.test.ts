import { afterEach, describe, expect, it } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import CollectionPost from './CollectionPost.vue'
import CollectionRow from './CollectionRow.vue'
import type { Collection } from '../api'
const fixture: Collection = {
  id: 'fixture',
  url: 'https://example.test/post',
  text: '收藏正文',
  author_name: '测试作者',
  saved_at: '2026-09-29T00:00:00Z',
  observed_at: '2026-09-29T00:00:00Z',
  visibility: 'private',
  revision_id: 'r1',
  assets: [
    {
      id: 'm1',
      state: 'ready',
      mime: 'image/png',
      sensitive: true,
      alt_text: '测试图片',
    },
  ],
}
let unmount = () => {}
type Mountable = Parameters<typeof createVaporApp>[0]
function mount(component: Mountable, collection: Collection) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(component, { collection })
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})
describe('Vapor collection rendering', () => {
  it.each([null, undefined, []])(
    'renders a detail with warnings=%s',
    (warnings) => {
      const el = mount(CollectionPost, { ...fixture, warnings })
      expect(el.textContent).toContain('收藏正文')
      expect(el.textContent).toContain('测试作者')
      expect(el.textContent).not.toContain('部分内容没有完整保存')
      expect(el.querySelector('.sensitive')).not.toBeNull()
    },
  )
  it('blurs sensitive media until the reader reveals it', async () => {
    const el = mount(CollectionPost, fixture)
    expect(el.textContent).toContain('收藏正文')
    expect(el.querySelector('img')).not.toBeNull()
    expect(el.querySelector('.blurred')).not.toBeNull()
    ;(el.querySelector('.sensitive') as HTMLButtonElement).click()
    await nextTick()
    expect(el.querySelector('.blurred')).toBeNull()
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      '/v1/assets/m1?inline=1',
    )
  })
  it('blurs sensitive thumbnails in a collection row', () => {
    const el = mount(CollectionRow, fixture)
    expect(el.textContent).toContain('测试作者')
    expect(el.querySelector('img')).not.toBeNull()
    expect(el.querySelector('.blurred')).not.toBeNull()
    expect(el.querySelector('.group-veil')?.getAttribute('aria-label')).toBe(
      '敏感内容，点按显示',
    )
  })
  it('shows a row thumbnail for ordinary media', () => {
    const el = mount(CollectionRow, {
      ...fixture,
      assets: [
        { id: 'm2', state: 'ready', mime: 'image/png', sensitive: false },
      ],
    })
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      '/v1/assets/m2?inline=1',
    )
    expect(el.textContent).toContain('1 张图片')
  })
  it("keeps storage states out of the reader's way", () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [
        { id: 'm3', state: 'failed', sensitive: false, error: 'download: 502' },
      ],
      warnings: ['resource omitted: unsupported type or resource limit'],
    })
    expect(el.textContent).toContain('这个媒体没能保存下来')
    expect(el.textContent).not.toContain('failed')
    expect(el.textContent).not.toContain('502')
    expect(el.textContent).toContain('部分媒体超出限制，没有保存。')
    expect(el.textContent).not.toContain('resource omitted')
  })
  it('records the post under the body, media and warnings', () => {
    const el = mount(CollectionPost, {
      ...fixture,
      published_at: '2026-09-28T10:00:00Z',
      warnings: ['resource omitted: unsupported type or resource limit'],
      graph: {
        root: 'p',
        relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
        entities: [
          {
            key: 'p',
            type: 'x.post',
            data: {
              published_at: '2026-09-28T10:00:00Z',
              replies: 0,
              reposts: 12,
              likes: 3456,
            },
          },
          {
            key: 'u',
            type: 'x.profile',
            data: {
              username: 'handle',
              metadata: { followers: 1234, likes: 56 },
            },
          },
        ],
      },
    })
    const record = el.querySelector('.record')!
    const precedes = (selector: string) =>
      !!(
        el.querySelector(selector)!.compareDocumentPosition(record) &
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    expect(precedes('.body')).toBe(true)
    expect(precedes('.media')).toBe(true)
    expect(precedes('.warning')).toBe(true)
    expect(record.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-09-28T10:00:00Z',
    )
    const stats = record.querySelector('.stats')!
    expect(stats.getAttribute('aria-label')).toBe('帖子统计')
    expect(
      [...stats.querySelectorAll('.stat')].map((s) => s.textContent),
    ).toEqual(['回复0', '转发12', '点赞3,456'])
    // The header signs the post; the account's own counts stay on its profile.
    expect(el.textContent).toContain('@handle')
    expect(el.textContent).not.toContain('1,234')
  })
  it('renders unknown entities without executing markup', () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [],
      text: '<script>alert(1)</script>',
      graph: {
        root: 'root',
        relations: [],
        entities: [{ key: 'root', type: 'notes.article', data: {} }],
      },
    })
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
  })
})
