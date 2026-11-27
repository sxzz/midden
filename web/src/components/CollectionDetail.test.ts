import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { shareSlug } from '../share'
import { collection, mockApi, type Request } from '../testing/api'
import CollectionDetail from './CollectionDetail.vue'
import type { Collection, HistoryPoint, Watch } from '../api'
const push = vi.fn()
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push, resolve }) }
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
/** The history every collection answers with. */
let history: HistoryPoint[] = []
/** The profile's watches (定期更新). */
let watches: Watch[] = []
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  shareSlug.value = ''
  history = []
  watches = []
  vi.unstubAllGlobals()
})

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
const post = collection({
  id: 'profile',
  url: 'https://x.com/synthetic/status/2',
  text: '合成帖子',
  graph: {
    root: 'post',
    relations: [],
    entities: [{ key: 'post', type: 'x.post', external_id: '2', data: {} }],
  },
})

async function mount(shown: Collection = profile) {
  /** What the collection's update answers, changed once one starts. */
  let update: object = { older: false }
  const sent: { path: string; body?: unknown }[] = []
  mockApi((path, request: Request) => {
    if (request.method === 'POST')
      sent.push({
        path,
        ...(request.body ? { body: JSON.parse(request.body) } : {}),
      })
    if (
      path === '/collections/profile' ||
      path === '/public/s/collections/profile'
    )
      return shown
    if (path.endsWith('/availability')) return { available: true }
    if (path.endsWith('/profile/follows'))
      return { following: 2, followers: 3, mutual: 1 }
    if (path === '/collections/profile/update') return update
    if (path === '/updates/preview')
      return shown === post
        ? { posts: 1, profiles: 0, listable: 0 }
        : {
            posts: 0,
            profiles: 1,
            listable: 1,
            counts: { following: 320, followers: 21_000 },
            older: false,
          }
    if (path === '/updates') {
      update = { record: { id: 'record', done: false }, older: false }
      return { id: 'record' }
    }
    if (path.startsWith('/watches?')) return { items: watches }
    if (path.startsWith('/shares')) return []
    if (path.endsWith('/annotation')) return { tags: [], note: '' }
    if (path.startsWith('/tags')) return []
    if (path.includes('/history')) return { items: history }
    if (path.includes('/collections?')) return { items: [] }
    return {}
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'key' })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionDetail, { id: 'profile' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      shown === profile ? '合成账号' : '合成帖子',
    ),
  )
  return { el, sent }
}

/** Each list group's rows, by the text that starts them. */
const groups = (el: HTMLElement) =>
  [...el.querySelectorAll('.section-body')].map((body) =>
    [...body.querySelectorAll(':scope > button, :scope > a, :scope > label')]
      .map((row) => row.textContent?.trim().replace(/›$/, '').trim())
      .filter(Boolean),
  )
const button = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!

it('puts 更新 and 查看进度 in a group of their own; 更新 opens the sheet', async () => {
  const { el, sent } = await mount()
  await vi.waitFor(() =>
    expect(groups(el)).toContainEqual(['更新', '定期更新']),
  )
  // Opening the original, sharing and deleting are elsewhere, and the lists
  // are an option of the sheet, not of the page.
  const update = el.querySelector<HTMLElement>('.update .section-body')!
  for (const other of ['打开原文', '公开分享', '删除这条收藏']) {
    expect(update.textContent).not.toContain(other)
    expect(el.textContent).toContain(other)
  }
  expect(el.textContent).not.toContain('抓关系网')
  button(update, '更新').click()
  const sheet = await vi.waitFor(() => {
    const open = el.querySelector<HTMLDialogElement>('dialog.sheet[open]')
    expect(open).not.toBeNull()
    return open!
  })
  await vi.waitFor(() => expect(sheet.textContent).toContain('抓关系网'))
  expect(sheet.textContent).toContain('更新 @synthetic')
  expect(sheet.textContent).toContain('帖子范围')
  expect(sheet.textContent).toContain(
    '关注 320 · 粉丝 2.1 万（超过 5000，将跳过粉丝名单）',
  )
  expect(sent).toEqual([
    {
      path: '/updates/preview',
      body: { target: { target: 'collection', id: 'profile' } },
    },
  ])
  button(sheet, '开始更新').click()
  // The update's progress joins the same group; the button says it runs.
  await vi.waitFor(() =>
    expect(groups(el)).toContainEqual(['正在更新…', '查看进度', '定期更新']),
  )
  expect(sent.at(-1)).toEqual({
    path: '/updates',
    body: {
      target: { target: 'collection', id: 'profile' },
      options: {
        posts: 'latest',
        count: 100,
        media_only: false,
        include_shared: true,
        capture_references: true,
        relations: false,
      },
    },
  })
})

it('a post opens the sheet with its references alone', async () => {
  const { el, sent } = await mount(post)
  const update = el.querySelector<HTMLElement>('.update .section-body')!
  await vi.waitFor(() => expect(button(update, '更新').disabled).toBe(false))
  button(update, '更新').click()
  const sheet = await vi.waitFor(() => {
    const open = el.querySelector<HTMLDialogElement>('dialog.sheet[open]')
    expect(open).not.toBeNull()
    return open!
  })
  await vi.waitFor(() =>
    expect(sheet.textContent).toContain('采集引用、转发的原帖'),
  )
  expect(sheet.textContent).not.toContain('抓帖子')
  expect(sheet.textContent).not.toContain('抓关系网')
  button(sheet, '开始更新').click()
  await vi.waitFor(() =>
    expect(groups(el)).toContainEqual(['正在更新…', '查看进度']),
  )
  expect(sent.at(-1)).toMatchObject({
    path: '/updates',
    body: { options: { capture_references: true } },
  })
})

it('puts the update group first, the date of the version under it', async () => {
  const { el } = await mount()
  await vi.waitFor(() =>
    expect(groups(el)).toContainEqual(['更新', '定期更新']),
  )
  const list = groups(el)
  const update = list.findIndex((rows) => rows[0] === '更新')
  const pages = list.findIndex((rows) =>
    rows.some((row) => row?.startsWith('公开分享')),
  )
  expect(update).toBeGreaterThanOrEqual(0)
  expect(pages).toBe(update + 1)
  const sections = [...el.querySelectorAll('.section')]
  const footnotes = sections.map((section) =>
    section.querySelector('.section-footnote')?.textContent?.trim(),
  )
  expect(footnotes[sections.indexOf(el.querySelector('.update')!)]).toMatch(
    /^最新版本抓取于 /,
  )
  expect(footnotes.filter(Boolean)).toHaveLength(1)
})

it('a watched profile says how often and when next; the row opens its sheet', async () => {
  const next = new Date()
  next.setHours(23, 5, 0, 0)
  watches = [
    {
      id: 'w',
      target: 'collection',
      target_id: 'profile',
      handle: 'synthetic',
      url: 'https://x.com/i/user/1',
      every: { count: 6, unit: 'hour' },
      time_zone: 'UTC',
      options: {
        posts: 'latest',
        count: 100,
        media_only: false,
        include_shared: true,
        capture_references: true,
        relations: false,
      },
      enabled: true,
      next_run_at: next.toISOString(),
      created_at: '2026-11-20T00:00:00Z',
    },
  ]
  const { el } = await mount()
  const update = el.querySelector<HTMLElement>('.update .section-body')!
  await vi.waitFor(() =>
    expect(update.textContent).toContain('定期更新下次 今天 23:05每 6 小时'),
  )
  ;[...update.querySelectorAll('button')]
    .find((b) => b.textContent?.startsWith('定期更新'))!
    .click()
  const sheet = await vi.waitFor(() => {
    const open = el.querySelector<HTMLDialogElement>('dialog.sheet[open]')
    expect(open?.textContent).toContain('定期更新 @synthetic')
    return open!
  })
  await vi.waitFor(() => expect(sheet.textContent).toContain('取消定期更新'))
  expect(
    sheet.querySelector<HTMLInputElement>('input[aria-label="间隔"]')?.value,
  ).toBe('6')
  expect(
    sheet.querySelector<HTMLSelectElement>('select[aria-label="单位"]')?.value,
  ).toBe('hour')
})

it('a post has no 定期更新', async () => {
  const { el } = await mount(post)
  await vi.waitFor(() => expect(groups(el)).toContainEqual(['更新']))
  expect(el.textContent).not.toContain('定期更新')
})

it('shows no update group behind a public link', async () => {
  shareSlug.value = 's'
  const { el } = await mount()
  expect(el.querySelector('.update')).toBeNull()
  expect(el.textContent).not.toContain('查看进度')
  expect(el.textContent).toContain('打开原文')
  // The date of the version stays, under the group of pages.
  const footnote = el.querySelector('.section-footnote')
  expect(footnote?.textContent).toMatch(/^最新版本抓取于 /)
  expect(footnote?.parentElement?.textContent).toContain('打开原文')
})

it('links each follow count to the library under the 关系 filter', async () => {
  const { el } = await mount()
  await vi.waitFor(() =>
    expect(el.querySelectorAll('.follows a')).toHaveLength(3),
  )
  const links = [...el.querySelectorAll<HTMLAnchorElement>('.follows a')]
  expect(links.map((a) => a.textContent)).toEqual(['2', '3', '1'])
  expect(
    links.map((a) => {
      const q = new URLSearchParams(a.getAttribute('href')!.split('?', 2)[1])
      return [q.get('entity_type'), q.get('rel_of'), q.get('rel')]
    }),
  ).toEqual(
    ['following', 'followers', 'mutual'].map((rel) => [
      'x.profile,instagram.profile',
      'x/x.profile/1',
      rel,
    ]),
  )
  links[2]!.click()
  expect(push).toHaveBeenLastCalledWith({
    name: 'collections',
    query: {
      entity_type: 'x.profile,instagram.profile',
      rel_of: 'x/x.profile/1',
      rel: 'mutual',
    },
  })
})

it('keeps the follow counts plain behind a public link', async () => {
  shareSlug.value = 's'
  const { el } = await mount()
  await vi.waitFor(() =>
    expect(el.querySelector('.follows')?.textContent).toContain('互关'),
  )
  expect(el.querySelector('.follows a')).toBeNull()
  expect(
    [...el.querySelectorAll('.follows dd')].map((dd) => dd.textContent),
  ).toEqual(['2', '3', '1'])
})

it("moves a profile's timeline to its 资料修改记录 page; a post keeps its own", async () => {
  history = ['c2', 'c1'].map((id) => ({
    capture_id: id,
    revision_id: id,
    observed_at: '2026-03-02T03:00:00.000Z',
  }))
  const { el } = await mount()
  // Two versions are enough for the page, with no change listed yet.
  const link = await vi.waitFor(() => {
    const found = [...el.querySelectorAll('a')].find(
      (a) => a.textContent?.trim().replace(/›$/, '').trim() === '资料修改记录',
    )
    expect(found).toBeDefined()
    return found!
  })
  expect(link.getAttribute('href')).toBe('/app/collection/profile/changes')
  expect(el.querySelector('input[type="range"]')).toBeNull()
  expect(el.textContent).not.toContain('资料变化')
  unmount()
  document.body.replaceChildren()
  const shown = await mount(post)
  await vi.waitFor(() =>
    expect(shown.el.querySelector('input[type="range"]')).not.toBeNull(),
  )
  expect(shown.el.textContent).toContain('内容变化')
  expect(shown.el.textContent).not.toContain('资料修改记录')
})
