import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, vaporInteropPlugin } from 'vue'
import { mockApi } from '../testing/api'
import { deleteEffect, inviteLeft, revokeEffect } from '../users'
import UsersView from './UsersView.vue'
import type { AppUser, Invite } from '../api'

vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

const admin: AppUser = {
  id: 'admin',
  name: '管理员',
  note: null,
  role: 'admin',
  created_at: '2026-01-01T00:00:00Z',
  revoked_at: null,
  passkeys: 2,
  sessions: 1,
  tokens: 1,
}
const friend: AppUser = {
  id: 'friend',
  name: '小明',
  note: '同事',
  role: 'viewer',
  created_at: '2026-11-20T00:00:00Z',
  revoked_at: null,
  passkeys: 2,
  sessions: 3,
  tokens: 1,
}
const pending: Invite = {
  id: 'invite',
  label: '小红',
  created_at: '2026-11-27T00:00:00Z',
  expires_at: new Date(Date.now() + 6 * 86_400_000 + 3_600_000).toISOString(),
  url: 'https://midden.test/invite#kept',
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
  vi.unstubAllGlobals()
})

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({ render: () => h(UsersView) }).use(vaporInteropPlugin)
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
const button = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!
const openSheet = () =>
  document.querySelector<HTMLDialogElement>('dialog.sheet[open]')!

it('says what revoking and deleting take, and how long an invite is good', () => {
  expect(revokeEffect(friend)).toBe('将删除2个通行密钥、3个登录、1个令牌。')
  expect(deleteEffect(friend)).toBe(
    '将删除这个用户和2个通行密钥、3个登录、1个令牌。',
  )
  expect(inviteLeft(pending)).toMatch(/^剩6天/)
  expect(inviteLeft({ expires_at: '2020-01-01T00:00:00Z' })).toBe('已过期')
})

it('lists the users and invites; the admin has no actions', async () => {
  mockApi((path) => {
    if (path === '/users')
      return [
        admin,
        friend,
        {
          ...friend,
          id: 'old',
          name: '旧',
          note: null,
          revoked_at: '2026-11-25T00:00:00Z',
        },
      ]
    if (path === '/invites') return [pending]
    return
  })
  const el = mount()
  await vi.waitFor(() => expect(el.textContent).toContain('小明'))
  const rows = [...el.querySelectorAll('.user')].map((row) => ({
    tag: row.tagName,
    text: row.textContent?.replaceAll(/\s+/g, ''),
  }))
  expect(rows[0]).toMatchObject({ tag: 'DIV' })
  expect(rows[0]!.text).toContain('管理员管理员')
  expect(rows[1]).toMatchObject({ tag: 'BUTTON' })
  // Their nickname, the admin's note beside it.
  expect(rows[1]!.text).toContain('小明同事查看者')
  expect(el.querySelector('.user .note')?.textContent).toBe('同事')
  expect(rows[1]!.text).toContain('2个通行密钥、3个登录、1个令牌')
  expect(rows[2]!.text).toContain('旧已撤销')
  expect(el.querySelector('.user.revoked')).not.toBeNull()
  expect(el.textContent).toContain('小红')
  expect(el.textContent).toMatch(/剩6天/)
})

it('revokes a user after saying what it takes', async () => {
  const sent: string[] = []
  mockApi((path, request) => {
    if (request.method !== 'GET') sent.push(`${request.method} ${path}`)
    if (path === '/users') return [admin, friend]
    if (path === '/invites') return []
    return friend
  })
  const el = mount()
  await vi.waitFor(() => expect(el.textContent).toContain('小明'))
  el.querySelector<HTMLButtonElement>('button.user')!.click()
  await settle()
  button(document.body, '撤销').click()
  await settle()
  const sheet = openSheet()
  expect(sheet.textContent).toContain('撤销小明？')
  expect(sheet.textContent).toContain(revokeEffect(friend))
  button(sheet, '撤销').click()
  await vi.waitFor(() => expect(sent).toEqual(['POST /users/friend/revoke']))
})

it('deletes a user once confirmed', async () => {
  const sent: string[] = []
  mockApi((path, request) => {
    if (request.method !== 'GET') sent.push(`${request.method} ${path}`)
    if (path === '/users') return [admin, friend]
    if (path === '/invites') return []
    return
  })
  const el = mount()
  await vi.waitFor(() => expect(el.textContent).toContain('小明'))
  el.querySelector<HTMLButtonElement>('button.user')!.click()
  await settle()
  button(document.body, '删除').click()
  await settle()
  const sheet = openSheet()
  expect(sheet.textContent).toContain(deleteEffect(friend))
  button(sheet, '删除').click()
  await vi.waitFor(() => expect(sent).toEqual(['DELETE /users/friend']))
})

it('makes an invite with a label and shows its link once', async () => {
  const sent: { path: string; body?: string }[] = []
  let invites: Invite[] = []
  mockApi((path, request) => {
    if (request.method === 'POST') {
      sent.push({ path, body: request.body })
      invites = [pending]
      return { invite: pending, url: 'https://midden.test/invite#secret' }
    }
    if (path === '/users') return [admin]
    if (path === '/invites') return invites
    return
  })
  const el = mount()
  await vi.waitFor(() => expect(el.querySelector('.user')).not.toBeNull())
  button(el, '邀请').click()
  await settle()
  const form = openSheet()
  const input = form.querySelector('input')!
  input.value = '小红'
  input.dispatchEvent(new Event('input'))
  await settle()
  button(form, '生成链接').click()
  await vi.waitFor(() =>
    expect(sent).toEqual([{ path: '/invites', body: '{"label":"小红"}' }]),
  )
  await vi.waitFor(() =>
    expect(openSheet().querySelector('input')?.value).toBe(
      'https://midden.test/invite#secret',
    ),
  )
  expect(openSheet().textContent).toContain('7天内有效，只能用一次。')
  expect(openSheet().textContent).not.toContain('只显示')
  // The pending invite is listed below the users.
  await vi.waitFor(() =>
    expect(el.querySelector('.invite')?.textContent).toContain('小红'),
  )
})

it('notes a user: the nickname stays theirs, an empty note clears it', async () => {
  const sent: { path: string; body?: string }[] = []
  mockApi((path, request) => {
    if (request.method === 'PATCH') sent.push({ path, body: request.body })
    if (path === '/users') return [admin, friend]
    if (path === '/invites') return []
    return friend
  })
  const el = mount()
  await vi.waitFor(() => expect(el.textContent).toContain('小明'))
  el.querySelector<HTMLButtonElement>('button.user')!.click()
  await settle()
  expect(button(document.body, '改名')).toBeUndefined()
  button(document.body, '备注').click()
  await settle()
  const form = openSheet()
  const input = form.querySelector('input')!
  expect(input.value).toBe('同事')
  input.value = ''
  input.dispatchEvent(new Event('input'))
  await settle()
  expect(button(form, '保存').disabled).toBe(false)
  button(form, '保存').click()
  await vi.waitFor(() =>
    expect(sent).toEqual([{ path: '/users/friend', body: '{"note":""}' }]),
  )
})

it('shows a pending invite’s link again, and makes it again once confirmed', async () => {
  const sent: string[] = []
  let invites: Invite[] = [
    pending,
    { ...pending, id: 'old', label: '旧', url: null },
  ]
  mockApi((path, request) => {
    if (request.method !== 'GET') sent.push(`${request.method} ${path}`)
    if (path === '/invites/old/regenerate') {
      const made = { ...invites[1]!, url: 'https://midden.test/invite#new' }
      invites = [pending, made]
      return { invite: made, url: made.url }
    }
    if (path === '/users') return [admin]
    if (path === '/invites') return invites
    return
  })
  const el = mount()
  await vi.waitFor(() => expect(el.querySelectorAll('.invite')).toHaveLength(2))
  const open = (i: number) =>
    el.querySelectorAll<HTMLButtonElement>('.invite button.open')[i]!.click()
  open(0)
  await settle()
  expect(openSheet().textContent).toContain('邀请小红')
  expect(openSheet().querySelector('input')?.value).toBe(
    'https://midden.test/invite#kept',
  )
  button(openSheet(), '完成').click()
  await settle()
  // One whose token was not kept: no link, nothing said of it.
  open(1)
  await settle()
  expect(openSheet().querySelector('input')).toBeNull()
  expect(button(openSheet(), '复制链接')).toBeUndefined()
  button(openSheet(), '重新生成').click()
  await settle()
  expect(openSheet().textContent).toContain('重新生成链接？')
  expect(openSheet().textContent).toContain('原链接立即失效。')
  button(openSheet(), '重新生成').click()
  await vi.waitFor(() =>
    expect(openSheet()?.querySelector('input')?.value).toBe(
      'https://midden.test/invite#new',
    ),
  )
  expect(sent).toEqual(['POST /invites/old/regenerate'])
})
