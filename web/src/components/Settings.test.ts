import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  h,
  KeepAlive,
  nextTick,
  vaporInteropPlugin,
  type Component,
} from 'vue'
import { mockApi } from '../testing/api'
import AdminView from './AdminView.vue'
import SettingsView from './SettingsView.vue'

const route = vi.hoisted(() => ({
  params: {} as Record<string, string>,
}))
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return {
    useRouter: () => ({ push: vi.fn(), resolve }),
    useRoute: () => route,
  }
})

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
  route.params = {}
  unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(component: Component, props: Record<string, unknown> = {}) {
  const el = document.createElement('div')
  document.body.append(el)
  // Settings pages live in the library's KeepAlive, which loads them.
  const app = createApp({
    render: () => h(KeepAlive, null, [h(component, props)]),
  }).use(vaporInteropPlugin)
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
const titles = (el: HTMLElement) =>
  [...el.querySelectorAll('h2')].map((h2) => h2.textContent?.trim())
const links = (el: HTMLElement) =>
  Object.fromEntries(
    [...el.querySelectorAll('a')].map((a) => [
      a.textContent?.replaceAll(/\s+/g, ''),
      a.getAttribute('href'),
    ]),
  )

describe('设置', () => {
  it('lists its sections as links that open them, then the facts', () => {
    mockApi()
    const el = mount(SettingsView)
    expect(links(el)).toMatchObject({
      通行密钥: '#/settings/passkeys',
      API令牌: '#/settings/tokens',
      管理员面板: '#/settings/admin',
      '源代码github.com/sxzz/midden↗': 'https://github.com/sxzz/midden',
    })
    // 采集账号 and 定期更新 are 采集's now.
    expect(el.textContent).not.toContain('采集账号')
    expect(el.textContent).not.toContain('定期更新')
    expect(titles(el)).toEqual(['关于'])
    expect(el.textContent).toContain('版本')
    expect(el.textContent).toContain('构建时间')
    // Outside Telegram a browser session can be ended here.
    expect(el.textContent).toContain('退出登录')
    // Another site opens in a new tab.
    const source = [...el.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('源代码'),
    )!
    expect(source.target).toBe('_blank')
  })

  it('opens the section the address names, in place', async () => {
    route.params = { section: 'admin' }
    mockApi()
    const el = mount(SettingsView)
    await settle()
    const admin = [...el.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === '管理员面板',
    )!
    // Open, its heading closes it; its entries open under it.
    expect(admin.getAttribute('aria-expanded')).toBe('true')
    expect(links(el)).toMatchObject({
      管理员面板: '#/settings',
      通行密钥: '#/settings/passkeys',
      存储用量: '#/settings/admin/storage',
      后台任务: '#/settings/admin/jobs',
    })
  })

  it('has no logout in the Mini App, which signs in on every open', () => {
    vi.stubGlobal('Telegram', { WebApp: { initData: 'signed' } })
    mockApi()
    const el = mount(SettingsView)
    expect(el.textContent).not.toContain('退出登录')
  })
})

describe('管理员面板', () => {
  const NO_BACKUP = {
    enabled: false,
    last_heartbeat_at: null,
    stale: false,
    stale_after_minutes: null,
  }
  const api = (dev: boolean, litestream: object = NO_BACKUP) =>
    mockApi((path, request) => {
      if (path === '/instance') return { dev, litestream }
      if (path === '/instance/litestream' && request.method === 'PUT')
        return {
          ...litestream,
          ...JSON.parse(request.body!),
        }
      if (path === '/origins')
        return [
          {
            id: 'o1',
            origin: 'https://midden.test',
            created_at: '2026-01-01T00:00:00Z',
            passkeys: 1,
          },
        ]
      if (path === '/library') return { collections: 3, records: 2, running: 0 }
      if (path === '/library/delete-all')
        return { collections: 3, records: 2, running: 0 }
      return
    })

  it('holds the domains, and nothing to delete outside development', async () => {
    api(false)
    const el = mount(AdminView)
    await settle()
    expect(titles(el)).toEqual(['域名'])
    expect(el.textContent).toContain('midden.test')
    expect(el.textContent).not.toContain('删除全部')
  })

  it('offers deleting everything on a development server', async () => {
    const calls = api(true)
    const cleared = vi.fn()
    const el = mount(AdminView, { onCleared: cleared })
    await settle()
    expect(titles(el)).toEqual(['域名', '开发模式'])
    const button = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '删除全部收藏和采集记录',
    )!
    button.click()
    await settle()
    expect(el.textContent).toContain('3 条收藏、2 条采集记录，无法恢复。')
    const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
    input.value = '删除全部'
    input.dispatchEvent(new Event('input'))
    await settle()
    const confirm = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '永久删除',
    )!
    confirm.click()
    await settle()
    expect(
      calls.mock.calls.some(
        ([path, request]) =>
          path === '/library/delete-all' && request.method === 'POST',
      ),
    ).toBe(true)
    expect(cleared).toHaveBeenCalledOnce()
  })

  it('shows no backup section where Litestream is not configured', async () => {
    api(false)
    const el = mount(AdminView)
    await settle()
    expect(el.textContent).not.toContain('数据库备份')
  })

  it('says when the last heartbeat arrived', async () => {
    api(false, {
      enabled: true,
      last_heartbeat_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      stale: false,
      stale_after_minutes: 20,
    })
    const el = mount(AdminView)
    await settle()
    expect(titles(el)).toEqual(['域名', '数据库备份'])
    expect(el.textContent).toContain('上次心跳 3 分钟前')
    expect(el.textContent).toContain('20 分钟')
  })

  it('says how long there has been no heartbeat', async () => {
    api(false, {
      enabled: true,
      last_heartbeat_at: null,
      stale: true,
      stale_after_minutes: 20,
    })
    const el = mount(AdminView)
    await settle()
    expect(el.textContent).toContain('超过 20 分钟没有心跳')
  })

  it('edits the heartbeat timeout', async () => {
    const calls = api(false, {
      enabled: true,
      last_heartbeat_at: null,
      stale: false,
      stale_after_minutes: 20,
    })
    const el = mount(AdminView)
    await settle()
    const button = (label: string) =>
      [...el.querySelectorAll('button')].find((b) =>
        b.textContent?.includes(label),
      )!
    button('备份心跳超时').click()
    await settle()
    const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
    expect(input.value).toBe('20')
    input.value = '0'
    input.dispatchEvent(new Event('input'))
    await settle()
    el.querySelector<HTMLButtonElement>('dialog[open] [type=submit]')!.click()
    await settle()
    expect(
      el.querySelector('dialog[open] [role=alert]')?.textContent,
    ).toContain('1 到 1440')
    expect(calls.mock.calls.some(([p]) => p === '/instance/litestream')).toBe(
      false,
    )

    input.value = '5'
    input.dispatchEvent(new Event('input'))
    await settle()
    el.querySelector<HTMLButtonElement>('dialog[open] [type=submit]')!.click()
    await settle()
    const put = calls.mock.calls.find(([p]) => p === '/instance/litestream')!
    expect(JSON.parse(put[1].body!)).toEqual({ stale_after_minutes: 5 })
    expect(el.textContent).toContain('5 分钟')
    expect(el.querySelector('dialog[open]')).toBeNull()
  })
})
