import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import {
  APIError,
  type ProfileChanges as Changes,
  type Collection,
  type HistoryPoint,
} from '../api'
import { asset, collection, mockApi } from '../testing/api'
import ProfileChanges from './ProfileChanges.vue'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

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
      id: 'r2',
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
      id: 'r1',
      observed_at: '2025-03-02T03:00:00.000Z',
      fields: [
        { field: 'username', before: 'old', after: 'new' },
        { field: 'banner', before: image('b1') },
      ],
    },
  ],
}

/** The profile as it is now, and at each point of its history. */
const profileAt = (name: string, revision: string): Collection =>
  collection({
    id: 'kept',
    url: 'https://x.com/i/user/1',
    revision_id: revision,
    saved_at: '2026-01-01T00:00:00.000Z',
    storage_bytes: 2048,
    source_state: 'suspended',
    warnings: ['帖子获取中断。'],
    graph: {
      root: 'profile',
      relations: [],
      entities: [
        {
          key: 'profile',
          type: 'x.profile',
          external_id: '1',
          data: {
            name,
            username: 'kobayashi',
            metadata: { description: '摄影', followers: 12 },
          },
        },
      ],
    },
  })
/** The history every profile answers with; one point has no timeline. */
let points: HistoryPoint[] = []
afterEach(() => {
  points = []
})
const point = (id: string, revision: string): HistoryPoint => ({
  capture_id: id,
  revision_id: revision,
  observed_at: '2026-03-02T03:00:00.000Z',
})

async function mount(answer: () => unknown, showSensitive = false) {
  const api = mockApi((path) => {
    if (path === '/collections/kept') return profileAt('小林 🌸', 'r2')
    if (path === '/collections/kept/history') return { items: points }
    if (path === '/collections/kept/history/c1') return profileAt('小林', 'r1')
    return answer()
  })
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

it('links each pinned post to its collection, else to the platform', async () => {
  const pinned: Changes = {
    items: [
      {
        capture_id: 'c3',
        revision_id: 'r3',
        id: 'r3',
        observed_at: today.toISOString(),
        fields: [
          {
            field: 'pinned',
            before: [{ id: '7', url: 'https://x.com/i/web/status/7' }],
            after: [
              {
                id: '8',
                url: 'https://x.com/i/web/status/8',
                collection_id: 'saved',
                text: '置顶的话',
              },
            ],
          },
        ],
      },
      {
        capture_id: 'c2',
        revision_id: 'r2',
        id: 'r2',
        observed_at: today.toISOString(),
        fields: [
          {
            field: 'pinned',
            before: [],
            after: [{ id: '7', url: 'https://x.com/i/web/status/7' }],
          },
        ],
      },
      {
        capture_id: 'c1',
        revision_id: 'r1',
        id: 'r1',
        observed_at: today.toISOString(),
        fields: [
          {
            field: 'pinned',
            before: [{ id: '6', url: 'https://x.com/i/web/status/6' }],
            after: [],
          },
        ],
      },
    ],
  }
  const { el } = await mount(() => pinned)
  const [changed, set, unset] = [...el.querySelectorAll('.entry')]
  expect(text(changed!.querySelector('.label'))).toBe('置顶帖子')
  const links = [...changed!.querySelectorAll('a')]
  expect(links.map(text)).toEqual(['x.com/i/web/status/7', '置顶的话'])
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    'https://x.com/i/web/status/7',
    '/collection/saved',
  ])
  expect(links[0]!.getAttribute('target')).toBe('_blank')
  expect(
    [...changed!.querySelectorAll('.post .mark')].map((m) => text(m)),
  ).toEqual(['原', '新'])
  expect(text(set!.querySelector('.label'))).toBe('置顶帖子新增')
  expect(text(unset!.querySelector('.label'))).toBe('置顶帖子取消置顶')
  expect(
    [...unset!.querySelectorAll('.post .mark')].map((m) => text(m)),
  ).toEqual(['原'])
})

it('moves through the profile with the timeline, showing only what can change', async () => {
  points = [point('c2', 'r2'), point('c1', 'r1')]
  const { el, api } = await mount(() => changes)
  const versions = await vi.waitFor(() => {
    const found = el.querySelector('.versions')
    expect(found).not.toBeNull()
    return found!
  })
  expect(text(versions.querySelector('.heading'))).toBe('资料版本')
  expect(text(versions.querySelector('.name'))).toBe('小林 🌸')
  expect(versions.textContent).toContain('摄影')
  // Counts change from point to point; the record's own facts, the
  // account's current state and the capture's warnings do not belong here.
  expect(versions.textContent).toContain('关注者')
  for (const fact of [
    '保存于',
    'UID',
    'UUID',
    '占用',
    '已被封禁',
    '帖子获取中断',
  ])
    expect(versions.textContent).not.toContain(fact)
  // The timeline sits under the profile, then the list of changes.
  const slider = versions.querySelector<HTMLInputElement>(
    'input[type="range"]',
  )!
  expect(slider.getAttribute('aria-label')).toBe('资料版本')
  expect(versions.nextElementSibling?.classList.contains('day')).toBe(true)
  slider.value = '0'
  slider.dispatchEvent(new Event('input'))
  await vi.waitFor(() =>
    expect(text(versions.querySelector('.name'))).toBe('小林'),
  )
  expect(api).toHaveBeenCalledWith(
    '/collections/kept/history/c1',
    expect.anything(),
  )
})

it('shows no timeline for a profile with one version', async () => {
  points = [point('c2', 'r2')]
  const { el, api } = await mount(() => changes)
  await vi.waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/collections/kept/history',
      expect.anything(),
    ),
  )
  await nextTick()
  expect(el.querySelector('.versions')).toBeNull()
  expect(el.querySelector('.entry')).not.toBeNull()
})
