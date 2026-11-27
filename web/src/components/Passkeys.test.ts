import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  h,
  KeepAlive,
  vaporInteropPlugin,
  type Component,
} from 'vue'
import { APIError, type Passkey, type WebOrigin } from '../api'
import { defaultPasskeyName } from '../passkey'
import { mockApi } from '../testing/api'
import OriginList from './OriginList.vue'
import PasskeyList from './PasskeyList.vue'
import PasskeyLogin from './PasskeyLogin.vue'
import PasskeySetup from './PasskeySetup.vue'

const browser = vi.hoisted(() => ({
  supported: true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}))
vi.mock('@simplewebauthn/browser', async (original) => ({
  ...(await original<typeof import('@simplewebauthn/browser')>()),
  browserSupportsWebAuthn: () => browser.supported,
  startAuthentication: browser.startAuthentication,
  startRegistration: browser.startRegistration,
}))

let unmount = () => {}
beforeEach(() => {
  browser.supported = true
  browser.startAuthentication.mockResolvedValue({ id: 'assertion' })
  browser.startRegistration.mockResolvedValue({ id: 'attestation' })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(component: Component, props: Record<string, unknown> = {}) {
  const el = document.createElement('div')
  document.body.append(el)
  // The settings page lives in the library's KeepAlive, which loads it.
  const app = createApp({
    render: () => h(KeepAlive, null, [h(component, props)]),
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text || b.ariaLabel === text,
  )
  if (!found) throw new Error(`no button reading “${text}”`)
  return found
}
const bodies = (api: ReturnType<typeof mockApi>, path: string) =>
  api.mock.calls
    .filter(([p, r]) => p === path && r.method !== 'GET')
    .map(([, r]) => (r.body ? JSON.parse(r.body) : undefined))

describe('login page', () => {
  it('signs in with a passkey and says how to get the first one', async () => {
    const api = mockApi((path) =>
      path === '/auth/passkey/options' ? { challenge: 'c' } : undefined,
    )
    const done = vi.fn()
    const el = mount(PasskeyLogin, { onDone: done })
    expect(el.textContent).toContain('首次使用请在 Telegram 中发送 /passkey')
    button(el, '使用通行密钥登录').click()
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(browser.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'c' },
    })
    expect(bodies(api, '/auth/passkey')).toEqual([
      { response: { id: 'assertion' } },
    ])
  })

  it('shows what the server said, and nothing when the prompt is closed', async () => {
    mockApi((path) => {
      if (path === '/auth/passkey/options') return { challenge: 'c' }
      throw new APIError(400, '找不到这个通行密钥')
    })
    const el = mount(PasskeyLogin)
    button(el, '使用通行密钥登录').click()
    await vi.waitFor(() =>
      expect(el.querySelector('[role=alert]')?.textContent).toBe(
        '找不到这个通行密钥',
      ),
    )
    browser.startAuthentication.mockRejectedValueOnce(
      new DOMException('closed', 'NotAllowedError'),
    )
    button(el, '使用通行密钥登录').click()
    await vi.waitFor(() => expect(el.querySelector('[role=alert]')).toBeNull())
  })
})

describe('registration page', () => {
  it('registers with the link token and a default name', async () => {
    const api = mockApi((path) =>
      path === '/auth/passkey/register/options'
        ? { challenge: 'c' }
        : { id: 'p', name: 'x', rp_id: 'localhost', created_at: '' },
    )
    const done = vi.fn()
    const el = mount(PasskeySetup, { token: 'T'.repeat(43), onDone: done })
    const input = el.querySelector('input')!
    expect(input.value).toContain(location.host)
    input.value = '  我的手机 '
    input.dispatchEvent(new Event('input'))
    button(el, '创建通行密钥').click()
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(bodies(api, '/auth/passkey/register/options')).toEqual([
      { token: 'T'.repeat(43) },
    ])
    expect(bodies(api, '/auth/passkey/register')).toEqual([
      {
        token: 'T'.repeat(43),
        name: '我的手机',
        response: { id: 'attestation' },
      },
    ])
  })

  it('says when the link is no longer good', async () => {
    mockApi(() => {
      throw new APIError(403, '链接已失效，请在 Telegram 中重新发送 /passkey')
    })
    const el = mount(PasskeySetup, { token: 'T'.repeat(43) })
    button(el, '创建通行密钥').click()
    await vi.waitFor(() =>
      expect(el.querySelector('[role=alert]')?.textContent).toBe(
        '链接已失效，请在 Telegram 中重新发送 /passkey',
      ),
    )
    expect(browser.startRegistration).not.toHaveBeenCalled()
  })
})

describe('passkey management', () => {
  let passkeys: Passkey[]
  let api: ReturnType<typeof mockApi>
  beforeEach(() => {
    passkeys = [
      {
        id: 'a',
        name: 'Mac Safari · midden.test',
        rp_id: 'midden.test',
        created_at: '2026-11-01T08:00:00.000Z',
        last_used_at: '2026-11-20T08:00:00.000Z',
      },
      {
        id: 'b',
        name: 'iPhone',
        rp_id: 'archive.example',
        created_at: '2026-11-02T08:00:00.000Z',
      },
    ]
    api = mockApi((path, request) => {
      if (path === '/passkeys' && request.method === 'GET') return passkeys
      if (path === '/passkeys/options') return { challenge: 'c' }
      if (path === '/passkeys') {
        const { name } = JSON.parse(request.body!) as { name: string }
        const added = { id: 'c', name, rp_id: 'localhost', created_at: '' }
        passkeys = [...passkeys, added]
        return added
      }
      const id = path.slice('/passkeys/'.length).split('?', 1)[0]
      if (request.method === 'DELETE') {
        passkeys = passkeys.filter((p) => p.id !== id)
        return
      }
      const { name } = JSON.parse(request.body!) as { name: string }
      passkeys = passkeys.map((p) => (p.id === id ? { ...p, name } : p))
      return passkeys.find((p) => p.id === id)
    })
  })

  it('lists name, domain, created and last used', async () => {
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    const rows = [...el.querySelectorAll('.passkey')].map((r) => r.textContent)
    expect(rows[0]).toContain('midden.test')
    expect(rows[0]).toContain('创建于')
    expect(rows[0]).toContain('上次使用')
    expect(rows[1]).toContain('archive.example')
    expect(rows[1]).not.toContain('上次使用')
  })

  it('adds one for this domain without Telegram', async () => {
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    button(el, '添加通行密钥').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.passkey')).toHaveLength(3),
    )
    expect(bodies(api, '/passkeys')).toEqual([
      { name: defaultPasskeyName(), response: { id: 'attestation' } },
    ])
  })

  it('has no add button where passkeys do not work', async () => {
    browser.supported = false
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    expect(el.textContent).not.toContain('添加通行密钥')
  })

  it('renames', async () => {
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    button(el, '重命名 iPhone').click()
    await vi.waitFor(() =>
      expect(el.querySelector('dialog[open] input')).not.toBeNull(),
    )
    const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
    expect(input.value).toBe('iPhone')
    input.value = '旧手机'
    input.dispatchEvent(new Event('input'))
    button(el, '保存').click()
    await vi.waitFor(() => expect(el.textContent).toContain('旧手机'))
    expect(bodies(api, '/passkeys/b')).toEqual([{ name: '旧手机' }])
  })

  it('confirms before deleting, and notes /passkey for the last one', async () => {
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    button(el, '删除 iPhone').click()
    const sheet = () => el.querySelector('dialog[open]')
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect(sheet()!.textContent).not.toContain('/passkey')
    expect(api.mock.calls.some(([, r]) => r.method === 'DELETE')).toBe(false)
    button(el, '删除通行密钥').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.passkey')).toHaveLength(1),
    )
    button(el, '删除 Mac Safari · midden.test').click()
    await vi.waitFor(() => expect(sheet()?.textContent).toContain('/passkey'))
    expect(sheet()!.textContent).toContain(
      '可以在 Telegram 中发送 /passkey 添加新的通行密钥。',
    )
    button(el, '删除通行密钥').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.passkey')).toHaveLength(0),
    )
  })

  it('signs the other devices out too, unless unchecked', async () => {
    const el = mount(PasskeyList)
    await vi.waitFor(() => expect(el.textContent).toContain('iPhone'))
    const sheet = () => el.querySelector('dialog[open]')
    const option = () =>
      sheet()!.querySelector<HTMLInputElement>('input[type=checkbox]')!
    const deleted = () =>
      api.mock.calls
        .filter(([, r]) => r.method === 'DELETE')
        .map(([path]) => path)
    button(el, '删除 iPhone').click()
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect(sheet()!.textContent).toContain('同时退出所有其他设备')
    expect(option().checked).toBe(true)
    button(el, '删除通行密钥').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.passkey')).toHaveLength(1),
    )
    // Unchecked once; the next sheet starts checked again.
    button(el, '删除 Mac Safari · midden.test').click()
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect(option().checked).toBe(true)
    option().click()
    button(el, '删除通行密钥').click()
    await vi.waitFor(() => expect(deleted()).toHaveLength(2))
    expect(deleted()).toEqual([
      '/passkeys/b?sign_out_others=true',
      '/passkeys/a',
    ])
  })
})

describe('domains', () => {
  let origins: WebOrigin[]
  let api: ReturnType<typeof mockApi>
  beforeEach(() => {
    origins = [
      { origin: 'https://midden.test', passkeys: 0 },
      {
        id: 'b',
        origin: 'https://archive.example',
        passkeys: 2,
        created_at: '2026-11-02T08:00:00.000Z',
      },
    ]
    api = mockApi((path, request) => {
      if (path === '/origins' && request.method === 'GET') return origins
      if (path === '/origins') {
        const { origin } = JSON.parse(request.body!) as { origin: string }
        if (!origin.startsWith('https://'))
          throw new APIError(400, '请输入 https 开头的地址')
        const added = {
          id: 'c',
          origin: new URL(origin).origin,
          passkeys: 0,
          created_at: '2026-11-03T08:00:00.000Z',
        }
        origins = [...origins, added]
        return added
      }
      const id = path.slice('/origins/'.length)
      const removed = origins.find((o) => o.id === id)!
      origins = origins.filter((o) => o.id !== id)
      return { passkeys: removed.passkeys }
    })
  })

  it('lists the built-in domain without a delete button', async () => {
    const el = mount(OriginList)
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.origin')).toHaveLength(2),
    )
    const rows = [...el.querySelectorAll('.origin')]
    expect(rows[0]!.textContent).toContain('midden.test')
    expect(rows[0]!.textContent).toContain('Mini App 地址')
    expect(rows[0]!.querySelector('button')).toBeNull()
    expect(rows[1]!.textContent).toContain('2 个通行密钥')
    expect(() => button(el, '删除 archive.example')).not.toThrow()
  })

  it('adds a domain, showing what the server refuses', async () => {
    const el = mount(OriginList)
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.origin')).toHaveLength(2),
    )
    button(el, '添加域名').click()
    await vi.waitFor(() =>
      expect(el.querySelector('dialog[open] input')).not.toBeNull(),
    )
    const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
    expect(input.inputMode).toBe('url')
    input.value = 'http://plain.test'
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(button(el, '添加').disabled).toBe(false))
    button(el, '添加').click()
    await vi.waitFor(() =>
      expect(el.querySelector('[role=alert]')?.textContent).toContain(
        '请输入 https 开头的地址',
      ),
    )
    input.value = 'https://new.example/app/'
    input.dispatchEvent(new Event('input'))
    button(el, '添加').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.origin')).toHaveLength(3),
    )
    expect(bodies(api, '/origins')).toEqual([
      { origin: 'http://plain.test' },
      { origin: 'https://new.example/app/' },
    ])
  })

  it('confirms removal with the passkeys it deletes, then reports it', async () => {
    const removed = vi.fn()
    const el = mount(OriginList, { onRemoved: removed })
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.origin')).toHaveLength(2),
    )
    button(el, '删除 archive.example').click()
    const sheet = () => el.querySelector('dialog[open]')
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect(sheet()!.textContent).toContain('将同时删除此域名的 2 个通行密钥')
    expect(api.mock.calls.some(([, r]) => r.method === 'DELETE')).toBe(false)
    button(el, '删除域名').click()
    await vi.waitFor(() =>
      expect(el.querySelectorAll('.origin')).toHaveLength(1),
    )
    expect(removed).toHaveBeenCalledOnce()
  })
})

describe('default name', () => {
  it('names the device and browser, then the domain', () => {
    expect(
      defaultPasskeyName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'midden.test',
      ),
    ).toBe('iPhone Safari · midden.test')
    expect(
      defaultPasskeyName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'a.test',
      ),
    ).toBe('Mac Chrome · a.test')
    expect(defaultPasskeyName('curl/8', 'a.test')).toBe('a.test')
  })
})
