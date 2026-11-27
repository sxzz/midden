import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createVaporApp, nextTick, vaporInteropPlugin } from 'vue'
import { toastState } from '../composables/useToast'
import { mediaRemovals } from '../media-removals'
import { removalEffectText } from '../presentation'
import { shareSlug } from '../share'
import { asset, collection, mockApi, type Request } from '../testing/api'
import BatchRefresh from './BatchRefresh.vue'
import CollectionDetail from './CollectionDetail.vue'
import MediaGallery from './MediaGallery.vue'
import MediaThumbs from './MediaThumbs.vue'
import type { Collection } from '../api'

vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

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

  it('offers no restore on a public page', () => {
    const el = mountVue(MediaGallery, {
      assets: [{ ...removedVideo, kind: 'image' }],
      collection: post,
    })
    expect(el.textContent).toContain('图片已移除')
    expect(el.querySelectorAll('button.restore')).toHaveLength(0)
  })

  it('names the restore by whether the original is still stored', () => {
    const el = mountVue(MediaGallery, {
      assets: [
        { ...removedVideo, recoverable: true },
        { ...removedVideo, id: 'w' },
        { ...removedVideo, id: 'x', download_again: true },
        { ...removedVideo, id: 'y', restore_error: '媒体服务器拒绝了请求' },
      ],
      collection: post,
      editable: true,
    })
    expect(
      [...el.querySelectorAll('button.restore')].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(['恢复', '恢复下载', '恢复下载', '恢复下载'])
    expect(el.textContent).toContain('无法重新下载：媒体服务器拒绝了请求')
    expect(el.textContent).not.toContain('下次更新时重新下载')
  })

  it('shows 下载中 over the kept thumbnail while it downloads again', () => {
    const el = mountVue(MediaGallery, {
      assets: [{ ...removedVideo, state: 'pending', restoring: true }],
      collection: post,
      editable: true,
    })
    expect(el.querySelector('.removed img')?.getAttribute('src')).toBe(
      '/media/thumb',
    )
    expect(el.querySelector('[role="status"]')?.textContent).toBe('下载中')
    expect(el.querySelectorAll('button.restore')).toHaveLength(0)
    expect(el.textContent).not.toContain('媒体保存中')
  })

  it('stays in list thumbnails, linking to the collection', async () => {
    const el = mountVue(MediaThumbs, {
      assets: [removedVideo],
      collectionId: 'post',
    })
    const tile = el.querySelector<HTMLAnchorElement>('a.tile')!
    expect(tile.getAttribute('aria-label')).toBe('视频已移除，查看帖子')
    expect(tile.textContent).toContain('已移除')
    expect(tile.getAttribute('href')).toBe('/app/collection/post')
  })

  it('removes one item from the viewer (删除此媒体)', async () => {
    const sent: { path: string; body?: unknown }[] = []
    mockApi((path, request: Request) => {
      if (request.method === 'POST')
        sent.push({ path, body: JSON.parse(request.body ?? 'null') })
      return { media: 1, freed_bytes: 1024, shared: 0 }
    })
    const removals = mediaRemovals.value
    const el = mountVue(MediaGallery, { assets: [photo], collection: post })
    el.querySelector<HTMLButtonElement>('.frame')!.click()
    await nextTick()
    document.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click()
    await nextTick()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    const sheet = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('dialog')].find(
        (d) => d.open && d.textContent?.includes('删除此媒体？'),
      )
      expect(found?.textContent).toContain('可释放')
      return found!
    })
    buttons(sheet, '删除')[0]!.click()
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        path: '/media-removals',
        body: { collection: 'post', asset: 'p' },
      }),
    )
    await vi.waitFor(() => expect(mediaRemovals.value).toBe(removals + 1))
  })

  it('the viewer offers no removal without a collection or behind a link', async () => {
    const el = mountVue(MediaGallery, { assets: [photo] })
    el.querySelector<HTMLButtonElement>('.frame')!.click()
    await nextTick()
    expect(document.querySelector('dialog.viewer')).not.toBeNull()
    expect(document.querySelector('[aria-label="更多"]')).toBeNull()
    unmount()
    document.body.replaceChildren()
    shareSlug.value = 'slug'
    try {
      const shared = mountVue(MediaGallery, {
        assets: [photo],
        collection: post,
      })
      shared.querySelector<HTMLButtonElement>('.frame')!.click()
      await nextTick()
      expect(document.querySelector('[aria-label="下载"]')).not.toBeNull()
      expect(document.querySelector('[aria-label="更多"]')).toBeNull()
    } finally {
      shareSlug.value = ''
    }
  })
})

/**
 * The detail page against an API that records what it is sent; `shown`
 * answers each read of the collection.
 */
async function mountDetail(shown: Collection | (() => Collection)) {
  const sent: { path: string; body?: unknown }[] = []
  const read = typeof shown === 'function' ? shown : () => shown
  let restored: unknown
  mockApi((path, request: Request) => {
    if (request.method === 'POST')
      sent.push({
        path,
        ...(request.body ? { body: JSON.parse(request.body) } : {}),
      })
    if (path === '/collections/post') return read()
    if (path.endsWith('/availability')) return { available: true }
    if (path === '/collections/post/update') return { older: false }
    if (path === '/media-removals/preview')
      return { media: 2, freed_bytes: 3 * 1024 * 1024, shared: 0 }
    if (path === '/media-removals')
      return { media: 2, freed_bytes: 3 * 1024 * 1024, shared: 0 }
    if (path === '/media-removals/restore') return restored
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
  return {
    el,
    sent,
    /** What a restore answers. */
    restores: (answer: unknown) => (restored = answer),
  }
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

  it('restores an item still stored at once, capturing nothing', async () => {
    let restored = false
    const { el, sent, restores } = await mountDetail(() =>
      restored
        ? { ...post, assets: [{ ...photo, id: 'v' }, photo] }
        : { ...post, assets: [{ ...removedVideo, recoverable: true }, photo] },
    )
    restores({ state: 'ready' })
    restored = true
    buttons(el, '恢复')[0]!.click()
    await vi.waitFor(() => expect(el.querySelector('.removed')).toBeNull())
    expect(sent).toEqual([
      {
        path: '/media-removals/restore',
        body: { collection: 'post', asset: 'v' },
      },
    ])
    expect(toastState.value?.text).not.toBe('已恢复下载')
  })

  it('shows an item downloading again until it is in', async () => {
    let reads = 0
    let restored = false
    const restoring = {
      ...post,
      assets: [
        { ...removedVideo, state: 'pending', restoring: true as const },
        photo,
      ],
    }
    const ready = { ...post, assets: [{ ...photo, id: 'v' }, photo] }
    const { el, sent, restores } = await mountDetail(() => {
      if (!restored) return post
      // Read again after the restore, it is still downloading.
      return ++reads > 1 ? ready : restoring
    })
    restores({ state: 'downloading', job: 7 })
    restored = true
    buttons(el, '恢复下载')[0]!.click()
    await vi.waitFor(() =>
      expect(el.querySelector('[role="status"]')?.textContent).toBe('下载中'),
    )
    expect(el.querySelector('.removed img')?.getAttribute('src')).toBe(
      '/media/thumb',
    )
    await vi.waitFor(() => expect(el.querySelector('.removed')).toBeNull(), {
      timeout: 5000,
    })
    expect(sent.map((s) => s.path)).toEqual(['/media-removals/restore'])
  }, 10_000)
})

describe('the profile detail', () => {
  const profile = collection({
    id: 'profile',
    url: 'https://x.com/synthetic',
    text: '合成账号',
    graph: {
      root: 'profile',
      relations: [],
      entities: [
        {
          key: 'profile',
          type: 'x.profile',
          external_id: '1',
          data: { username: 'synthetic' },
        },
      ],
    },
  })
  const effect = {
    posts: 5,
    videos: 7,
    freed_bytes: 3 * 1024 * 1024,
    shared: 0,
    kept: { listed: 0, saved: 2, annotated: 1, quoted: 0 },
    elsewhere: 0,
  }

  it('restores its media as a post does, with no update to wait for', async () => {
    const sent: string[] = []
    mockApi((path, request: Request) => {
      if (request.method === 'POST') sent.push(path)
      if (path === '/collections/profile')
        return { ...profile, assets: [removedVideo] }
      if (path.endsWith('/availability')) return { available: true }
      if (path === '/collections/profile/update') return { older: false }
      if (path === '/collections/profile/video-removal') return {}
      if (path === '/media-removals/restore')
        return { state: 'downloading', job: 1 }
      if (path.startsWith('/shares')) return []
      if (path.endsWith('/annotation')) return { tags: [], note: '' }
      if (path.startsWith('/tags')) return []
      if (path.includes('/collections?') || path.includes('/history'))
        return { items: [] }
      return {}
    })
    toastState.value = undefined
    const el = document.createElement('div')
    document.body.append(el)
    const app = createVaporApp(CollectionDetail, { id: 'profile' })
    app.mount(el)
    unmount = () => app.unmount()
    await vi.waitFor(() => expect(buttons(el, '恢复下载')).toHaveLength(1))
    buttons(el, '恢复下载')[0]!.click()
    await vi.waitFor(() => expect(sent).toEqual(['/media-removals/restore']))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toEqual(['/media-removals/restore'])
    expect(toastState.value).toBeUndefined()
  })

  it('shows a removed banner in its box, with the restore', async () => {
    const sent: { path: string; body?: unknown }[] = []
    const banner = {
      ...removedVideo,
      id: 'b',
      kind: 'image',
      purpose: 'banner',
      recoverable: true as const,
    }
    const withBanner = {
      ...profile,
      graph: {
        ...profile.graph!,
        entities: [{ ...profile.graph!.entities[0]!, assets: [banner] }],
      },
    }
    mockApi((path, request: Request) => {
      if (request.method === 'POST')
        sent.push({ path, body: JSON.parse(request.body ?? 'null') })
      if (path === '/collections/profile') return withBanner
      if (path.endsWith('/availability')) return { available: true }
      if (path === '/collections/profile/update') return { older: false }
      if (path === '/media-removals/restore') return { state: 'ready' }
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
    const cover = await vi.waitFor(() => {
      const found = el.querySelector('.cover-kept')
      expect(found).not.toBeNull()
      return found!
    })
    expect(cover.querySelector('img')?.getAttribute('src')).toBe('/media/thumb')
    expect(cover.textContent).toContain('已移除')
    buttons(cover, '恢复')[0]!.click()
    await vi.waitFor(() =>
      expect(sent).toEqual([
        {
          path: '/media-removals/restore',
          body: { collection: 'profile', asset: 'b' },
        },
      ]),
    )
  })

  it('removes all of its videos as a job, stating the counts first', async () => {
    const sent: string[] = []
    const removal = {
      id: 'removal',
      created_at: '2026-01-01T00:00:00.000Z',
      state: 'queued',
      removed: 0,
    }
    // What each look at the removal finds once it started.
    const looks = [
      { ...removal, state: 'running', effect, removed: 3 },
      { ...removal, state: 'complete', effect, removed: 7 },
    ]
    let started = false
    mockApi((path, request: Request) => {
      if (request.method === 'POST') sent.push(path)
      if (path === '/collections/profile') return profile
      if (path.endsWith('/availability')) return { available: true }
      if (path === '/collections/profile/update') return { older: false }
      if (path === '/collections/profile/video-removal/preview') return effect
      if (path === '/collections/profile/video-removal') {
        if (request.method === 'POST') {
          started = true
          return removal
        }
        if (!started) return {}
        return { removal: looks.length > 1 ? looks.shift() : looks[0] }
      }
      if (path.startsWith('/shares')) return []
      if (path.endsWith('/annotation')) return { tags: [], note: '' }
      if (path.startsWith('/tags')) return []
      if (path.includes('/collections?') || path.includes('/history'))
        return { items: [] }
      return {}
    })
    const before = mediaRemovals.value
    const el = document.createElement('div')
    document.body.append(el)
    const app = createVaporApp(CollectionDetail, { id: 'profile' })
    app.mount(el)
    unmount = () => app.unmount()
    await vi.waitFor(() => expect(buttons(el, '删除所有视频')).toHaveLength(1))
    buttons(el, '删除所有视频')[0]!.click()
    const sheet = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('dialog')].find(
        (d) => d.open && d.textContent?.includes('删除所有视频？'),
      )
      expect(found?.textContent).toContain(
        '将删除 5 条帖子的 7 个视频，可释放 3.0 MB（保留 3 条帖子的视频：单独收藏 2 条、已整理 1 条）',
      )
      return found!
    })
    buttons(sheet, '删除')[0]!.click()
    await vi.waitFor(() => expect(buttons(el, '正在删除视频…')).toHaveLength(1))
    expect(sheet.open).toBe(false)
    // Followed while it runs, with how far it got.
    await vi.waitFor(
      () =>
        expect(
          [...el.querySelectorAll('button')].some((b) =>
            b.textContent?.includes('正在删除视频…3 / 7'),
          ),
        ).toBe(true),
      { timeout: 3000 },
    )
    await vi.waitFor(
      () => expect(buttons(el, '删除所有视频')).toHaveLength(1),
      { timeout: 3000 },
    )
    expect(toastState.value?.text).toBe('已删除 7 个视频')
    // The pages listing the media load again.
    expect(mediaRemovals.value).toBe(before + 1)
    expect(sent).toEqual([
      '/collections/profile/video-removal/preview',
      '/collections/profile/video-removal',
    ])
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
