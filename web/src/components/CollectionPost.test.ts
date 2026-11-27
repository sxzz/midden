import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { asset, collection, entity } from '../testing/api'
import CollectionPost from './CollectionPost.vue'
import CollectionRow from './CollectionRow.vue'
import type { Asset, Collection, Entity } from '../api'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})
const fixture = collection({
  id: 'fixture',
  url: 'https://example.test/post',
  text: '收藏正文',
  author_name: '测试作者',
  saved_at: '2026-09-29T00:00:00Z',
  observed_at: '2026-09-29T00:00:00Z',
  revision_id: 'r1',
  assets: [
    asset({
      id: 'm1',
      url: '/v1/assets/m1?inline=1',
      state: 'ready',
      mime: 'image/png',
      sensitive: true,
      alt_text: '测试图片',
    }),
  ],
})
let unmount = () => {}
type Mountable = Parameters<typeof createVaporApp>[0]
function mount(
  component: Mountable,
  collection: Collection,
  props: { showSensitive?: boolean } = {},
) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(component, { collection, ...props })
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
      // An older server could leave warnings out or send null.
      const el = mount(CollectionPost, {
        ...fixture,
        warnings: warnings as string[],
      })
      expect(el.textContent).toContain('收藏正文')
      expect(el.textContent).toContain('测试作者')
      expect(el.textContent).not.toContain('内容不完整')
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
        asset({
          id: 'm2',
          url: '/v1/assets/m2?inline=1',
          state: 'ready',
          mime: 'image/png',
          sensitive: false,
        }),
      ],
    })
    expect(el.querySelector('img')?.getAttribute('src')).toBe(
      '/v1/assets/m2?inline=1',
    )
    // The thumbnail is the summary; a row no longer counts the media in words.
    expect(el.textContent).not.toContain('1 张图片')
  })
  it("keeps storage states out of the reader's way", () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [
        asset({
          id: 'm3',
          url: '/v1/assets/m3?inline=1',
          state: 'failed',
          sensitive: false,
          error: 'download: 502',
        }),
      ],
      warnings: ['部分资源类型不支持或资源数量超过限制'],
    })
    expect(el.textContent).toContain('媒体保存失败')
    expect(el.textContent).not.toContain('failed')
    expect(el.textContent).not.toContain('502')
    expect(el.textContent).toContain('部分资源类型不支持或资源数量超过限制')
  })
  it('records the post under the body, media and warnings', () => {
    const el = mount(CollectionPost, {
      ...fixture,
      published_at: '2026-09-28T10:00:00Z',
      warnings: ['部分资源类型不支持或资源数量超过限制'],
      graph: {
        root: 'p',
        relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
        entities: [
          entity({
            key: 'p',
            type: 'x.post',
            data: {
              published_at: '2026-09-28T10:00:00Z',
              replies: 0,
              reposts: 12,
              likes: 3456,
            },
          }),
          entity({
            key: 'u',
            type: 'x.profile',
            data: {
              username: 'handle',
              metadata: { followers: 1234, likes: 56 },
            },
          }),
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
  it('links the author identity to a saved profile and places storage in the record', () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [],
      storage_bytes: 1024,
      graph: {
        root: 'post',
        relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
        entities: [
          entity({ key: 'post', type: 'x.post', data: {} }),
          entity({
            key: 'author',
            type: 'x.profile',
            saved_collection_id: 'saved-profile',
            data: { username: 'handle' },
          }),
        ],
      },
    })
    const link = el.querySelector<HTMLAnchorElement>('.profile-link')!
    expect(link.getAttribute('href')).toBe('/app/collection/saved-profile')
    expect(link.textContent).toContain('测试作者')
    expect(link.textContent).toContain('@handle')
    expect(el.querySelector('.record')?.textContent).toContain('占用')
    expect(el.querySelector('.record')?.textContent).toContain('1.0 KB')
    expect(el.querySelector('.author')?.textContent).not.toContain('占用')
  })
  it('offers the captured profile only when it looks different', async () => {
    const post = (current: Entity['current']) =>
      mount(CollectionPost, {
        ...fixture,
        assets: [],
        graph: {
          root: 'post',
          relations: [
            { source: 'post', target: 'author', type: 'authored_by' },
          ],
          entities: [
            entity({ key: 'post', type: 'x.post', data: {} }),
            entity({
              key: 'author',
              type: 'x.profile',
              data: { name: '旧名字', metadata: { followers: 1 } },
              current,
            }),
          ],
        },
      })
    // Only the counts changed, so switching would show the same header.
    let el = post({
      id: 'v2',
      data: { name: '旧名字', metadata: { followers: 2 } },
    })
    expect(el.querySelector('.profile-version')).toBeNull()
    unmount()
    el = post({ id: 'v2', data: { name: '新名字' } })
    const toggle = el.querySelector<HTMLButtonElement>('.profile-version')!
    expect(toggle.textContent).toContain('抓取时资料')
    expect(el.querySelector('.author .name')?.textContent).toBe('新名字')
    toggle.click()
    await nextTick()
    expect(el.querySelector('.author .name')?.textContent).toBe('旧名字')
    expect(toggle.textContent).toContain('最新资料')
  })
  it('does not invent a profile link when no profile was saved', () => {
    const el = mount(CollectionPost, fixture)
    expect(el.querySelector('.profile-link')).toBeNull()
  })
  it('renders unknown entities without executing markup', () => {
    const el = mount(CollectionPost, {
      ...fixture,
      assets: [],
      text: '<script>alert(1)</script>',
      graph: {
        root: 'root',
        relations: [],
        entities: [entity({ key: 'root', type: 'notes.article', data: {} })],
      },
    })
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
  })
  describe('a profile banner', () => {
    const banner = (fields: Partial<Asset> = {}) =>
      asset({
        id: 'banner',
        purpose: 'banner',
        position: 1,
        url: '/media/banner',
        thumbnail_url: '/media/banner-600x200',
        mime: 'image/jpeg',
        width: 600,
        height: 200,
        ...fields,
      })
    const profile = (
      type: string,
      assets: Asset[],
      props: { showSensitive?: boolean } = {},
    ) =>
      mount(
        CollectionPost,
        {
          ...fixture,
          assets: [],
          graph: {
            root: 'root',
            relations: [],
            entities: [
              entity({
                key: 'root',
                type,
                data: { name: '山野记录', metadata: { description: '简介' } },
                assets: [
                  asset({ id: 'avatar', purpose: 'avatar', url: '/media/a' }),
                  ...assets,
                ],
              }),
            ],
          },
        },
        props,
      )
    it('shows the thumbnail in a 3:1 box above the avatar and name', () => {
      const el = profile('x.profile', [banner()])
      const cover = el.querySelector('.cover')!
      expect(cover.querySelector('img')?.getAttribute('src')).toBe(
        '/media/banner-600x200',
      )
      // The banner comes first, and the saved one opens in the viewer.
      expect(el.querySelector('article')?.firstElementChild).toBe(cover)
      expect(cover.querySelector('button')?.getAttribute('aria-label')).toBe(
        '查看山野记录的主页封面',
      )
      expect(el.querySelector('article.with-cover')).not.toBeNull()
    })
    it("falls back to the platform's own address, which does not open", () => {
      const el = profile('x.profile', [
        banner({
          state: 'failed',
          url: undefined,
          thumbnail_url: undefined,
          remote_url: 'https://pbs.twimg.com/profile_banners/7/1/1500x500',
        }),
      ])
      expect(el.querySelector('.cover img')?.getAttribute('src')).toBe(
        'https://pbs.twimg.com/profile_banners/7/1/1500x500',
      )
      expect(el.querySelector('.cover button')).toBeNull()
    })
    it('collapses without a banner', () => {
      const el = profile('x.profile', [])
      expect(el.querySelector('.cover')).toBeNull()
      expect(el.querySelector('article.with-cover')).toBeNull()
      expect(el.textContent).toContain('山野记录')
    })
    it('shows a removed banner as removed, never as the banner itself', () => {
      const el = profile('x.profile', [
        banner({ state: 'removed', url: undefined }),
      ])
      // Its kept thumbnail, under 已移除, opening nothing.
      expect(el.querySelector('.cover-kept')?.textContent).toContain('已移除')
      expect(el.querySelector('.cover-button')).toBeNull()
    })
    it('leaves a sensitive banner out until sensitive media is shown', () => {
      const sensitive = banner({ sensitive: true })
      let el = profile('x.profile', [sensitive])
      expect(el.querySelector('.cover')).toBeNull()
      unmount()
      el = profile('x.profile', [sensitive], { showSensitive: true })
      expect(el.querySelector('.cover img')).not.toBeNull()
    })
    it('is only for a profile, and Instagram has none to show', () => {
      expect(
        profile('instagram.profile', []).querySelector('.cover'),
      ).toBeNull()
      unmount()
      // A banner on a post's author belongs to the profile page, not the post.
      const el = mount(CollectionPost, {
        ...fixture,
        assets: [],
        graph: {
          root: 'post',
          relations: [
            { source: 'post', target: 'author', type: 'authored_by' },
          ],
          entities: [
            entity({ key: 'post', type: 'x.post' }),
            entity({
              key: 'author',
              type: 'x.profile',
              assets: [banner()],
            }),
          ],
        },
      })
      expect(el.querySelector('.cover')).toBeNull()
    })
  })
})
