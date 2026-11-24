import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { APIError, type ProfileChanges as Changes } from '../api'
import { asset, mockApi } from '../testing/api'
import ProfileChanges from './ProfileChanges.vue'

// jsdom has neither a modal dialog nor media queries; the viewer only needs to
// reach the DOM here.
beforeAll(() => {
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
})

const image = (id: string, sensitive = false) =>
  asset({
    id,
    purpose: 'avatar',
    mime: 'image/jpeg',
    sensitive,
    url: `/media/${id}`,
    thumbnail_url: `/media/${id}-small`,
  })
const today = new Date()
today.setHours(9, 5, 0, 0)
const changes: Changes = {
  items: [
    {
      capture_id: 'c2',
      revision_id: 'r2',
      observed_at: today.toISOString(),
      fields: [
        { field: 'name', before: '小林', after: '小林 🌸' },
        { field: 'bio', after: '摄影 / 旅行' },
        { field: 'protected', before: false, after: true },
        { field: 'avatar', before: image('a1'), after: image('a2', true) },
      ],
    },
    {
      capture_id: 'c1',
      revision_id: 'r1',
      observed_at: '2025-03-02T03:00:00.000Z',
      fields: [
        { field: 'username', before: 'old', after: 'new' },
        { field: 'banner', before: image('b1') },
      ],
    },
  ],
}

async function mount(answer: () => unknown, showSensitive = false) {
  const api = mockApi(answer)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(ProfileChanges, { id: 'kept', showSensitive })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(api).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  return { el, api }
}
const text = (el: Element | null | undefined) =>
  el?.textContent?.replaceAll(/\s+/g, ' ').trim()

it('lists each change under its day, newest first, old value then new', async () => {
  const { el, api } = await mount(() => changes)
  expect(api).toHaveBeenCalledWith('/collections/kept/profile-changes', {
    method: 'GET',
    signal: expect.any(AbortSignal),
  })
  expect([...el.querySelectorAll('.day-label')].map(text)).toEqual([
    '今天',
    '2025年3月2日',
  ])
  const [latest, first] = [...el.querySelectorAll('.entry')]
  expect(text(latest!.querySelector('time'))).toBe('9:05')
  expect(latest!.querySelector('time')?.getAttribute('datetime')).toBe(
    today.toISOString(),
  )
  const lines = [...latest!.querySelectorAll('.line')]
  expect(
    lines.map((line) => text(line.querySelector('.label, .flag'))),
  ).toEqual(['昵称', '简介新增', '设为受保护', '头像'])
  expect(text(lines[0]!.querySelector('del'))).toBe('小林')
  expect(text(lines[0]!.querySelector('ins'))).toBe('小林 🌸')
  // An added bio has nothing before it.
  expect(lines[1]!.querySelector('del')).toBeNull()
  expect(lines[2]!.querySelector('.lock-icon')).not.toBeNull()
  expect(
    [...first!.querySelectorAll('.line')].map((line) =>
      text(line.querySelector('.label')),
    ),
  ).toEqual(['用户名', '主页封面移除'])
  expect(text(first!.querySelector('ins'))).toBe('@new')
  expect(first!.querySelector('.wide img')?.getAttribute('src')).toBe(
    '/media/b1-small',
  )
  expect(el.querySelector('.footnote')).toBeNull()
})

it('covers a sensitive image until tapped, then opens both in the viewer', async () => {
  const { el } = await mount(() => changes)
  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('.image')]
  const [old, covered] = buttons()
  expect(old!.getAttribute('aria-label')).toBe('放大原头像')
  expect(covered!.classList.contains('blurred')).toBe(true)
  expect(covered!.getAttribute('aria-label')).toBe('敏感内容，点按显示')
  covered!.click()
  await nextTick()
  // The first tap only uncovers it.
  expect(document.querySelector('dialog.viewer')).toBeNull()
  expect(buttons()[1]!.classList.contains('blurred')).toBe(false)
  buttons()[1]!.click()
  await nextTick()
  expect(document.querySelector('dialog.viewer')).not.toBeNull()
  expect(text(document.querySelector('.counter'))).toBe('2 / 2')
})

it('shows sensitive images when the reader shows them everywhere', async () => {
  const { el } = await mount(() => changes, true)
  expect(el.querySelector('.blurred')).toBeNull()
})

it('says when older revisions were not compared, and reports failures', async () => {
  const { el } = await mount(() => ({ ...changes, truncated: true }))
  expect(text(el.querySelector('.footnote'))).toBe(
    '只比较了最近 1000 个版本，更早的修改未列出。',
  )
  unmount()
  document.body.replaceChildren()
  const failed = await mount(() => {
    throw new APIError(404, '内容不存在或已删除')
  })
  expect(text(failed.el.querySelector('[role="alert"]'))).toBe(
    '内容不存在或已删除',
  )
  expect(failed.el.querySelector('.entry')).toBeNull()
})
