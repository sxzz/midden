import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { APIError, type FollowChanges as Changes } from '../api'
import { asset, mockApi } from '../testing/api'
import FollowChanges from './FollowChanges.vue'
const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push, resolve }) }
})

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
})

const today = new Date()
today.setHours(9, 5, 0, 0)
const yesterday = new Date(today)
yesterday.setDate(today.getDate() - 1)
yesterday.setHours(20, 0, 0, 0)
const changes: Changes = {
  items: [
    {
      type: 'follow',
      observed_at: today.toISOString(),
      since: yesterday.toISOString(),
      account: {
        entity_id: 'e1',
        external_id: '1',
        name: '小林',
        username: 'kobayashi',
        collection_id: 'c1',
        avatar: asset({
          id: 'a1',
          purpose: 'avatar',
          url: '/media/a1',
          thumbnail_url: '/media/a1-small',
        }),
      },
    },
    {
      type: 'unfollowed_by',
      observed_at: today.toISOString(),
      since: yesterday.toISOString(),
      account: { entity_id: 'e2', external_id: '2', username: 'gone' },
    },
    {
      type: 'unfollow',
      observed_at: '2025-03-02T03:00:00.000Z',
      since: '2025-02-20T03:00:00.000Z',
      account: { entity_id: 'e3', external_id: '3', name: '旧友' },
    },
  ],
}

async function mount(answer: () => unknown) {
  const api = mockApi(answer)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(FollowChanges, { id: 'kept' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(api).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  return { el, api }
}
const text = (el: Element | null | undefined) =>
  el?.textContent?.replaceAll(/\s+/g, ' ').trim()

it('lists follow changes under their day, newest first, saying when they happened', async () => {
  const { el, api } = await mount(() => changes)
  expect(api).toHaveBeenCalledWith('/collections/kept/follow-changes', {
    method: 'GET',
    signal: expect.any(AbortSignal),
  })
  expect([...el.querySelectorAll('.day-label')].map(text)).toEqual([
    '今天',
    '2025年3月2日',
  ])
  const [latest, older] = el.querySelectorAll('.entry')
  expect(text(latest!.querySelector('.time'))).toBe('9:05')
  // Observation times: between the fetch before and this one.
  expect(
    [...latest!.querySelectorAll('.label')].map((label) =>
      text(label.firstChild as Element),
    ),
  ).toEqual(['新关注 1', '掉粉 1'])
  expect([...latest!.querySelectorAll('.note')].map(text)).toEqual([
    '昨天 20:00 之后',
    '昨天 20:00 之后',
  ])
  expect([...latest!.querySelectorAll('.account-row')].map(text)).toEqual([
    '小林@kobayashi',
    '@gone',
  ])
  expect(latest!.querySelector('img')?.getAttribute('src')).toBe(
    '/media/a1-small',
  )
  expect(text(older!.querySelector('.note'))).toMatch(
    /^2025年2月\d+日 \d+:00 之后$/,
  )
})

it('opens a saved account, and leaves an unsaved one as text', async () => {
  const { el } = await mount(() => changes)
  const links = el.querySelectorAll<HTMLAnchorElement>('a.account-row')
  expect(links).toHaveLength(1)
  expect(links[0]!.getAttribute('href')).toBe('/collection/c1')
  links[0]!.click()
  expect(push).toHaveBeenCalledWith({
    name: 'collection',
    params: { id: 'c1' },
  })
})

it('shows an avatar only the platform has, sending no referrer, linked or not', async () => {
  const remote = (id: string) =>
    asset({
      id,
      purpose: 'avatar',
      state: 'failed',
      remote_url: `https://pbs.twimg.com/profile_images/${id}.jpg`,
    })
  const { el } = await mount(() => ({
    items: [
      {
        ...changes.items[0]!,
        account: { ...changes.items[0]!.account, avatar: remote('r1') },
      },
      {
        ...changes.items[1]!,
        // Out of a share's scope: no link, but still name and avatar.
        account: { ...changes.items[1]!.account, avatar: remote('r2') },
      },
    ],
  }))
  const images = [...el.querySelectorAll('.avatar img')]
  expect(images.map((img) => img.getAttribute('src'))).toEqual([
    'https://pbs.twimg.com/profile_images/r1.jpg',
    'https://pbs.twimg.com/profile_images/r2.jpg',
  ])
  for (const img of images)
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
})

it('shows nothing at all without changes, and the error when loading fails', async () => {
  const empty = await mount(() => ({ items: [] }))
  expect(empty.el.querySelector('.day')).toBeNull()
  expect(text(empty.el)).toBe('')
  unmount()
  const failed = await mount(() => {
    throw new APIError(404, '内容不存在或已删除')
  })
  expect(text(failed.el.querySelector('[role=alert]'))).toBe(
    '内容不存在或已删除',
  )
})
