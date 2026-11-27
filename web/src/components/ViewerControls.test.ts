import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  createVaporApp,
  h,
  nextTick,
  shallowRef,
  vaporInteropPlugin,
} from 'vue'
import { redirectFor } from '../access'
import { shownSections } from '../settings-sections'
import { shownTabs } from '../tabbar'
import { collection, mockApi } from '../testing/api'
import { can, currentUser, setSession } from '../user'
import BatchRefresh from './BatchRefresh.vue'
import CollectionDetail from './CollectionDetail.vue'
import FolderMenuSheet from './FolderMenuSheet.vue'
import TokenFormSheet from './TokenFormSheet.vue'
import type { SessionInfo } from '../api'

// What a viewer is shown: every control they cannot use is gone, by the
// session's `can` (user.ts), and the reads they may not make are not made.

vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

const ADMIN: SessionInfo = {
  user: { id: 'admin', name: '管理员', role: 'admin' },
  can: {
    capture: true,
    organize: true,
    share: true,
    delete: true,
    admin: true,
  },
}
const VIEWER: SessionInfo = {
  user: { id: 'viewer', name: '小明', role: 'viewer' },
  can: {
    capture: false,
    organize: false,
    share: false,
    delete: false,
    admin: false,
  },
}

let unmount = () => {}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  setSession(ADMIN)
  vi.unstubAllGlobals()
})

function mount(component: object, props: Record<string, unknown> = {}) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({ render: () => h(component, props) }).use(
    vaporInteropPlugin,
  )
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
const texts = (root: Element, selector = 'button, a') =>
  [...root.querySelectorAll(selector)].map((b) =>
    (b.getAttribute('aria-label') || b.textContent || '').trim(),
  )

describe('the session', () => {
  it('takes what the server says, and the admin when it says nothing', () => {
    setSession(VIEWER)
    expect({ ...can }).toEqual(VIEWER.can)
    expect(currentUser()).toEqual({
      name: '小明',
      detail: `查看者 · ${location.host}`,
    })
    // A development server's stand-in answers (the tests' `{}`, a 204).
    setSession(undefined)
    expect({ ...can }).toEqual(ADMIN.can)
    expect(currentUser().detail).toBe(`管理员 · ${location.host}`)
  })

  it('leaves 采集 and 管理员面板 out for a viewer', () => {
    setSession(VIEWER)
    expect(shownTabs().map((t) => t.label)).toEqual(['探索', '关系', '设置'])
    expect(shownSections(can.admin).map((s) => s.label)).toEqual([
      '通行密钥',
      'API令牌',
      '关于',
    ])
    expect(redirectFor({ name: 'captures', params: {} })).toBe('/')
    expect(redirectFor({ name: 'capture', params: { id: 'r' } })).toBe('/')
    expect(
      redirectFor({
        name: 'settings-entry',
        params: { section: 'admin', entry: 'users' },
      }),
    ).toBe('/settings')
    expect(
      redirectFor({ name: 'settings-section', params: { section: 'tokens' } }),
    ).toBeUndefined()
    expect(redirectFor({ name: 'collections', params: {} })).toBeUndefined()
  })

  it('keeps every tab and section for the admin', () => {
    setSession(ADMIN)
    expect(shownTabs().map((t) => t.label)).toEqual([
      '探索',
      '采集',
      '关系',
      '设置',
    ])
    expect(shownSections(can.admin).map((s) => s.value)).toContain('admin')
    expect(redirectFor({ name: 'captures', params: {} })).toBeUndefined()
  })
})

describe("a collection's page", () => {
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
  async function show() {
    const asked: string[] = []
    mockApi((path) => {
      asked.push(path.split('?', 1)[0]!)
      if (path === '/collections/profile') return profile
      if (path.endsWith('/availability')) return { available: true }
      if (path === '/collections/profile/update') return { older: false }
      if (path.startsWith('/watches')) return { items: [] }
      if (path.startsWith('/shares')) return []
      if (path.endsWith('/annotation')) return { tags: [], note: '' }
      if (path.startsWith('/tags')) return []
      if (path.includes('/history')) return { items: [] }
      if (path.startsWith('/collections?')) return { items: [] }
      if (path.startsWith('/collections/count')) return { count: 0, types: {} }
      return {}
    })
    vi.stubGlobal('crypto', { randomUUID: () => 'key' })
    const el = document.createElement('div')
    document.body.append(el)
    const app = createVaporApp(CollectionDetail, { id: 'profile' })
    app.mount(el)
    unmount = () => app.unmount()
    await vi.waitFor(() => expect(el.textContent).toContain('合成账号'))
    await settle()
    return { el, asked }
  }
  const corner = (el: HTMLElement) =>
    texts(el.querySelector('.card-actions')!, ':scope > *')

  it('has the update, notes, sharing and deletions for the admin', async () => {
    const { el, asked } = await show()
    await vi.waitFor(() =>
      expect(corner(el)).toEqual(['更新', '打开原文', '更多操作']),
    )
    expect(el.textContent).toContain('我的整理')
    expect(el.textContent).toContain('定期更新')
    expect(asked).toEqual(
      expect.arrayContaining([
        '/collections/profile/availability',
        '/collections/profile/update',
        '/shares',
      ]),
    )
  })

  it('only reads for a viewer, and asks nothing of the admin', async () => {
    setSession(VIEWER)
    const { el, asked } = await show()
    expect(corner(el)).toEqual(['打开原文'])
    for (const hidden of [
      '我的整理',
      '定期更新',
      '公开分享',
      '删除这条收藏',
      '删除所有视频',
      '查看进度',
    ])
      expect(el.textContent).not.toContain(hidden)
    expect(el.querySelector('dialog')).toBeNull()
    for (const path of asked)
      expect(path).not.toMatch(
        /availability|\/update$|^\/shares|annotation|^\/tags|^\/watches|video-removal/,
      )
  })
})

describe('menus and forms', () => {
  it("leaves a folder's menu what the user may do", () => {
    const open = (session: SessionInfo) => {
      setSession(session)
      const el = mount(FolderMenuSheet, { open: true, name: '猫' })
      const shown = texts(el, '.action').filter((text) => text !== '取消')
      unmount()
      document.body.replaceChildren()
      return shown
    }
    expect(open(ADMIN)).toEqual([
      '更新收藏夹',
      '定期更新',
      '公开分享',
      '重命名',
      '删除收藏夹',
    ])
    // The admin's token: it writes, but deletes nothing.
    expect(open({ ...ADMIN, can: { ...ADMIN.can, delete: false } })).toEqual([
      '更新收藏夹',
      '定期更新',
      '公开分享',
      '重命名',
    ])
  })

  it('gives a viewer selecting accounts the comparison alone', async () => {
    setSession(VIEWER)
    mockApi(() => ({ items: [] }))
    const el = mount(BatchRefresh, {
      selected: ['a'],
      listed: ['a', 'b'],
      profiles: ['x:1'],
    })
    await settle()
    expect(texts(el.querySelector('.toolbar')!, 'button')).toEqual([
      '取消',
      '全选',
      '更多操作',
    ])
    // One account has nothing to compare with.
    expect(
      el.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.disabled,
    ).toBe(true)
    expect(el.textContent).not.toContain('删除')
  })

  it("makes a viewer's token read only, with no choice of permission", async () => {
    setSession(VIEWER)
    const submitted = vi.fn()
    // Opened after mounting, as the tokens page opens it.
    const open = shallowRef(false)
    const shown = mount({
      setup: () => () =>
        h(TokenFormSheet, { open: open.value, onSubmit: submitted }),
    })
    open.value = true
    await settle()
    expect(shown.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(shown.textContent).toContain('只读，只能用于Agent API')
    shown.querySelector<HTMLInputElement>('input')!.value = '脚本'
    shown
      .querySelector<HTMLInputElement>('input')!
      .dispatchEvent(new Event('input'))
    shown.querySelector('form')!.requestSubmit()
    await settle()
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({ label: '脚本', permission: 'ro' }),
    )
  })
})
