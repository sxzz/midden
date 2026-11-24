import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createVaporApp, nextTick, vaporInteropPlugin } from 'vue'
import { removalEffectText } from '../presentation'
import { asset, collection, mockApi, type Request } from '../testing/api'
import BatchRefresh from './BatchRefresh.vue'
import CollectionDetail from './CollectionDetail.vue'
import MediaGallery from './MediaGallery.vue'
import MediaThumbs from './MediaThumbs.vue'
import type { Collection } from '../api'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), resolve: () => ({ href: '#/' }) }),
}))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const removedVideo = asset({
  id: 'v',
  state: 'removed',
  kind: 'video',
  thumbnail: true,
  thumbnail_url: '/media/thumb',
})
const photo = asset({ id: 'p', mime: 'image/png', url: '/media/p' })
const post = collection({
  id: 'post',
  url: 'https://x.com/synthetic/status/2',
  text: '合成帖子',
  assets: [removedVideo, photo],
  graph: {
    root: 'post',
    relations: [],
    entities: [{ key: 'post', type: 'x.post', external_id: '2', data: {} }],
  },
})

function mountVue(component: object, props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(component, props).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}

const buttons = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].filter(
    (button) => button.textContent?.trim() === text,
  )

describe('the effect a removal states', () => {
  it('says what is freed, what other collections keep, or both', () => {
    const MB = 1024 * 1024
    expect(
      removalEffectText({ media: 2, freed_bytes: 120 * MB, shared: 0 }),
    ).toBe('可释放 120.0 MB')
    expect(removalEffectText({ media: 1, freed_bytes: 0, shared: 1 })).toBe(
      '其他收藏仍在使用，不会释放空间',
    )
    expect(
      removalEffectText({ media: 3, freed_bytes: 2 * MB, shared: 1 }),
    ).toBe('可释放 2.0 MB；其中 1 个媒体其他收藏仍在使用，不会释放空间')
    expect(removalEffectText({ media: 0, freed_bytes: 0, shared: 0 })).toBe(
      '没有可删除的媒体',
    )
  })
})

describe('removed media', () => {
  it('shows the kept thumbnail and links to the post on the platform', () => {
    const restore = vi.fn()
    const el = mountVue(MediaGallery, {
      assets: [removedVideo],
      collection: post,
      editable: true,
      onRestore: restore,
    })
    expect(el.querySelector('.removed img')?.getAttribute('src')).toBe(
      '/media/thumb',
    )
    const link = el.querySelector<HTMLAnchorElement>('.removed-label a')!
    expect(link.textContent).toBe('视频已移除 · 在原站查看 ›')
    expect(link.href).toBe('https://x.com/synthetic/status/2')
    buttons(el, '恢复下载')[0]!.click()
    expect(restore).toHaveBeenCalledWith(removedVideo)
  })

  it('offers no restore on a public page, nor once restored', () => {
    let el = mountVue(MediaGallery, {
      assets: [{ ...removedVideo, kind: 'image' }],
      collection: post,
    })
    expect(el.textContent).toContain('图片已移除')
    expect(buttons(el, '恢复下载')).toHaveLength(0)
    unmount()
    el = mountVue(MediaGallery, {
      assets: [{ ...removedVideo, download_again: true }],
      collection: post,
      editable: true,
    })
    expect(buttons(el, '恢复下载')).toHaveLength(0)
    expect(el.textContent).toContain('下次更新时重新下载')
  })

  it('stays in list thumbnails, opening the collection', async () => {
    const open = vi.fn()
    const el = mountVue(MediaThumbs, {
      assets: [removedVideo],
      onOpen: open,
    })
    const tile = el.querySelector<HTMLButtonElement>('.tile')!
    expect(tile.getAttribute('aria-label')).toBe('视频已移除，查看收藏详情')
    expect(tile.textContent).toContain('已移除')
    tile.click()
    await nextTick()
    expect(open).toHaveBeenCalled()
  })

  it('removes one item from the viewer (删除此媒体)', async () => {
    const remove = vi.fn()
    const el = mountVue(MediaGallery, {
      assets: [photo],
      editable: true,
      onRemove: remove,
    })
    el.querySelector<HTMLButtonElement>('.frame')!.click()
    await nextTick()
    document
      .querySelector<HTMLButtonElement>('[aria-label="删除此媒体"]')!
      .click()
    expect(remove).toHaveBeenCalledWith(photo)
  })

  it('the viewer offers no removal unless asked', async () => {
    const el = mountVue(MediaGallery, { assets: [photo] })
    el.querySelector<HTMLButtonElement>('.frame')!.click()
    await nextTick()
    expect(document.querySelector('dialog.viewer')).not.toBeNull()
    expect(document.querySelector('[aria-label="删除此媒体"]')).toBeNull()
  })
})

/** The detail page against an API that records what it is sent. */
async function mountDetail(shown: Collection) {
  const sent: { path: string; body?: unknown }[] = []
  mockApi((path, request: Request) => {
    if (request.method === 'POST')
      sent.push({
        path,
        ...(request.body ? { body: JSON.parse(request.body) } : {}),
      })
    if (path === '/collections/post') return shown
    if (path.endsWith('/availability')) return { available: true }
    if (path === '/collections/post/update') return { older: false }
    if (path === '/media-removals/preview')
      return { media: 2, freed_bytes: 3 * 1024 * 1024, shared: 0 }
    if (path === '/media-removals')
      return { media: 2, freed_bytes: 3 * 1024 * 1024, shared: 0 }
    if (path === '/media-removals/restore') return
    if (path === '/updates') return { id: 'record' }
    if (path.startsWith('/shares')) return []
    if (path.endsWith('/annotation')) return { tags: [], note: '' }
    if (path.startsWith('/tags')) return []
    if (path.includes('/collections?') || path.includes('/history'))
      return { items: [] }
    return {}
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'key' })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionDetail, { id: 'post' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('合成帖子'))
  return { el, sent }
}

describe('the post detail', () => {
  it("removes all of the post's media after stating the space freed", async () => {
    const { el, sent } = await mountDetail(post)
    buttons(el, '删除此帖所有媒体')[0]!.click()
    const sheet = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('dialog')].find(
        (d) => d.open && d.textContent?.includes('删除此帖所有媒体？'),
      )
      expect(found?.textContent).toContain('可释放 3.0 MB')
      return found!
    })
    buttons(sheet, '删除')[0]!.click()
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        path: '/media-removals',
        body: { ids: ['post'] },
      }),
    )
  })

  it('has no post action once every media item is removed', async () => {
    const { el } = await mountDetail({ ...post, assets: [removedVideo] })
    expect(buttons(el, '删除此帖所有媒体')).toHaveLength(0)
  })

  it('restores a removed item and updates the post at once', async () => {
    const { el, sent } = await mountDetail(post)
    buttons(el, '恢复下载')[0]!.click()
    await vi.waitFor(() =>
      expect(sent.map((s) => s.path)).toEqual([
        '/media-removals/restore',
        '/updates',
      ]),
    )
    expect(sent[0]!.body).toEqual({ collection: 'post', asset: 'v' })
  })
})

describe('the batch bar', () => {
  it('removes the media of every selected item (删除媒体)', async () => {
    const sent: { path: string; body?: unknown }[] = []
    mockApi((path, request) => {
      sent.push({ path, body: request.body && JSON.parse(request.body) })
      return { media: 4, freed_bytes: 0, shared: 4 }
    })
    const removed = vi.fn()
    const el = mountVue(BatchRefresh, {
      selected: ['a', 'b'],
      listed: ['a', 'b'],
      onMediaRemoved: removed,
    })
    el.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click()
    await nextTick()
    const menu = el.querySelector<HTMLDialogElement>('dialog[open]')!
    expect(menu.textContent).toContain('已选 2 项')
    buttons(menu, '删除媒体')[0]!.click()
    await nextTick()
    expect(menu.open).toBe(false)
    const sheet = [...document.querySelectorAll('dialog')].find((d) =>
      d.textContent?.includes('删除 2 项的媒体？'),
    )!
    await vi.waitFor(() =>
      expect(sheet.textContent).toContain('其他收藏仍在使用，不会释放空间'),
    )
    buttons(sheet, '删除')[0]!.click()
    await vi.waitFor(() => expect(removed).toHaveBeenCalled())
    expect(sent).toEqual([
      { path: '/media-removals/preview', body: { ids: ['a', 'b'] } },
      { path: '/media-removals', body: { ids: ['a', 'b'] } },
    ])
  })
})
