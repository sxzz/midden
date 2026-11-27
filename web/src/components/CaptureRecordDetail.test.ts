import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { mockApi } from '../testing/api'
import CaptureRecordDetail from './CaptureRecordDetail.vue'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const detail = (members: Record<string, number | boolean>) => ({
  id: 'record',
  job_id: 'job',
  collection_id: 'profile',
  saved: true,
  url: 'https://x.com/fixture',
  input: 'https://x.com/fixture',
  platform: 'x',
  kind: 'profile',
  state: 'complete',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-10-14T08:00:00Z',
  done: true,
  members: { total: 3, pending: 0, done: true, ...members },
  warnings: [],
  media_items: [],
  reasons: [],
})
const member = (
  id: string,
  state = 'complete',
  waiting?: 'queue' | 'retry',
) => ({
  job_id: id,
  collection_id: id,
  saved: true,
  url: `https://x.com/fixture/status/${id}`,
  state,
  // Saved with content, so it has a page to open.
  ...(state === 'complete' || state === 'partial' ? { library_id: id } : {}),
  ...(waiting ? { waiting } : {}),
  reasons: [],
  gone: false,
  created_at: '2026-10-14T08:00:01Z',
})

/** Mount a record whose members are listed by state filter. */
function mount(
  record: () => ReturnType<typeof detail>,
  lists: Record<string, object[]>,
) {
  const queried: string[] = []
  mockApi((path) => {
    const url = new URL(path, 'http://localhost')
    if (url.pathname === '/captures/record') return record()
    if (url.pathname === '/captures/record/members') {
      const state = url.searchParams.get('state') ?? ''
      queried.push(state)
      return { items: lists[state] ?? [] }
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  const tabs = () =>
    [...el.querySelectorAll('[role=tab]')].map((tab) => ({
      name: tab.textContent!.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
    }))
  const click = (name: string) =>
    [...el.querySelectorAll<HTMLElement>('[role=tab]')]
      .find((tab) => tab.textContent!.startsWith(name))!
      .click()
  return { el, queried, tabs, click }
}

it('splits posts into new, updated and failed ones, with counts', async () => {
  const { el, queried, tabs, click } = mount(
    () => detail({ complete: 3, partial: 0, failed: 1, added: 1, updated: 2 }),
    {
      added: [member('4')],
      updated: [member('1'), member('2')],
      problem: [member('3', 'failed')],
    },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/4'))
  expect(tabs()).toEqual([
    { name: '新增记录 1', selected: true },
    { name: '更新记录 2', selected: false },
    { name: '异常记录 1', selected: false },
  ])
  click('异常记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  expect(el.textContent).not.toContain('status/4')
  click('更新记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/2'))
  // A tab seen before shows again without loading.
  click('新增记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/4'))
  expect(queried).toEqual(['added', 'problem', 'updated'])
})

it('hides tabs without posts and opens the first one left', async () => {
  const { el, queried, tabs } = mount(
    () => detail({ complete: 2, partial: 0, failed: 1, added: 0, updated: 2 }),
    { updated: [member('1'), member('2')] },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([
    { name: '更新记录 2', selected: true },
    { name: '异常记录 1', selected: false },
  ])
  expect(queried).toEqual(['updated'])
})

it('heads the list with the only tab instead of a tab bar', async () => {
  const { el, tabs } = mount(
    () => detail({ complete: 2, partial: 0, failed: 0, added: 0, updated: 2 }),
    { updated: [member('1'), member('2')] },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([])
  expect(el.querySelector('[role=tablist]')).toBeNull()
  expect(el.querySelector('h2')?.textContent).toBe('更新记录')
})

it('shows no posts list for a record without posts', async () => {
  const { el, queried } = mount(
    () =>
      detail({
        total: 0,
        complete: 0,
        partial: 0,
        failed: 0,
        added: 0,
        updated: 0,
      }),
    {},
  )
  await vi.waitFor(() => expect(el.textContent).toContain('已完成'))
  expect(el.querySelector('[role=tablist]')).toBeNull()
  // Only the summary is left: no empty list or sentence about it.
  expect(el.querySelectorAll('section')).toHaveLength(1)
  expect(queried).toEqual([])
})

it('lists running posts until they finish, then leaves their tab', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const running = {
    ...detail({ complete: 1, partial: 0, failed: 0, added: 1, updated: 0 }),
    done: false,
  }
  running.members = { ...running.members, pending: 3, done: false }
  const record = { current: running }
  const { el, queried, tabs } = mount(() => record.current, {
    added: [member('1')],
    pending: [
      member('2', 'downloading'),
      member('3', 'queued'),
      member('4', 'queued', 'queue'),
    ],
  })
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([
    { name: '新增记录 1', selected: true },
    { name: '进行中 3', selected: false },
  ])
  ;[...el.querySelectorAll<HTMLElement>('[role=tab]')].at(-1)!.click()
  await vi.waitFor(() => expect(el.textContent).toContain('status/4'))
  // A member being fetched is not waiting in the queue.
  expect(
    [...el.querySelectorAll('.line-trailing')].map((s) => s.textContent),
  ).toEqual(['正在保存媒体', '正在采集', '排队中'])

  // One finishes as a new post, one fails: the running tab goes and the
  // first tab left opens.
  record.current = detail({
    complete: 2,
    partial: 0,
    failed: 1,
    added: 2,
    updated: 0,
  })
  await vi.advanceTimersByTimeAsync(2500)
  await vi.waitFor(() =>
    expect(tabs()).toEqual([
      { name: '新增记录 2', selected: true },
      { name: '异常记录 1', selected: false },
    ]),
  )
  expect(queried).toEqual(['added', 'pending', 'added'])
  vi.useRealTimers()
})

it('lists every post of a record from before new and updated were told apart', async () => {
  const { el, queried, tabs } = mount(
    () => detail({ complete: 2, partial: 1, failed: 0 }),
    { '': [member('1'), member('2'), member('3', 'partial')] },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  expect(tabs()).toEqual([
    { name: '全部 3', selected: true },
    { name: '异常记录 1', selected: false },
  ])
  expect(queried).toEqual([''])
})

it("heads an old record's only list as the posts", async () => {
  const { el, tabs } = mount(
    () => detail({ complete: 3, partial: 0, failed: 0 }),
    { '': [member('1'), member('2'), member('3')] },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  expect(tabs()).toEqual([])
  expect(el.querySelector('h2')?.textContent).toBe('帖子')
})

it('an update: its target as the title, its profiles part by part, its lists as members', async () => {
  const update = () => ({
    ...detail({}),
    url: '',
    collection_id: '',
    kind: '',
    state: 'queued',
    done: false,
    members: {
      total: 6,
      complete: 3,
      partial: 0,
      failed: 1,
      pending: 1,
      done: false,
      added: 1,
      updated: 2,
    },
    update: {
      target: 'folder',
      target_id: 'folder',
      name: '猫',
      posts: 2,
      profiles: 1,
      options: { posts: 'latest', relations: true },
      queued: 1,
      skipped: 0,
    },
    profiles: [
      {
        collection_id: 'p1',
        url: 'https://x.com/i/user/1',
        handle: 'cat',
        state: 'complete',
        posts: { total: 100, finished: 34, pending: 66, done: false },
        relations: [
          { list: 'following', state: 'complete', fetched: 3 },
          { list: 'followers', state: 'skipped', fetched: 0, expected: 6000 },
        ],
      },
    ],
  })
  const { el, tabs, click } = mount(update as never, {
    added: [member('4')],
    pending: [
      {
        ...member('list'),
        url: 'https://x.com/i/user/1',
        state: 'queued',
        list: 'following',
        handle: 'cat',
      } as never,
    ],
  })
  await vi.waitFor(() => expect(el.textContent).toContain('更新收藏夹「猫」'))
  expect(el.textContent).toContain(
    '正在更新 · 新增 1 · 更新 2 · 异常 1 · 进行中 2',
  )
  expect(Number(el.querySelector('progress')?.value)).toBeCloseTo(4 / 6)
  // A folder has no link of its own.
  expect(el.textContent).not.toContain('打开原链接')
  // The profiles are a tab of their own, before the updated posts.
  expect(tabs().map((t) => t.name)).toEqual([
    '新增记录 1',
    '账号 1',
    '更新记录 2',
    '异常记录 1',
    '进行中 1',
  ])
  expect(el.textContent).not.toContain('资料 ✓')
  click('账号')
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      '资料 ✓ · 帖子 34/100 · 关注 ✓ · 粉丝 跳过',
    ),
  )
  expect(el.textContent).toContain('@cat')
  expect(el.textContent).not.toContain('status/4')
  click('进行中')
  await vi.waitFor(() => expect(el.textContent).toContain('@cat 关注名单'))
})

it('continues a profile the post cap stopped, inside the same record', async () => {
  let continued = false
  const update = () => ({
    ...detail({ complete: 1000, partial: 0, failed: 0 }),
    update: {
      target: 'collection',
      target_id: 'p1',
      handle: 'cat',
      posts: 0,
      profiles: 1,
      older: false,
      queued: 0,
      skipped: 0,
    },
    options: {
      posts: 'until_existing',
      media_only: true,
      include_shared: true,
      capture_references: true,
      relations: false,
    },
    profiles: [
      {
        collection_id: 'p1',
        url: 'https://x.com/i/user/1',
        handle: 'cat',
        state: 'complete',
        posts: continued
          ? {
              total: 1100,
              finished: 1000,
              pending: 100,
              done: false,
              capped: false,
            }
          : {
              total: 1000,
              finished: 1000,
              pending: 0,
              done: true,
              capped: true,
            },
      },
    ],
  })
  const sent: unknown[] = []
  mockApi((path, request) => {
    if (path === '/captures/record') return update()
    if (path.startsWith('/captures/record/members')) return { items: [] }
    if (path === '/updates/record/continue' && request.method === 'POST') {
      sent.push(JSON.parse(request.body!))
      continued = true
      return
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.querySelector('[role=tab]')).not.toBeNull())
  ;[...el.querySelectorAll<HTMLElement>('[role=tab]')]
    .find((tab) => tab.textContent!.startsWith('账号'))!
    .click()
  await vi.waitFor(() =>
    expect(el.textContent).toContain('资料 ✓ · 帖子 1000（未到已有数据）'),
  )
  // What the update ran with stays visible.
  expect(el.textContent).toContain('选项抓到已有数据为止 · 仅媒体')
  const button = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '继续抓取',
  )!
  button.click()
  await vi.waitFor(() => expect(el.textContent).toContain('帖子 1000/1100'))
  expect(sent).toEqual([{ collection_id: 'p1' }])
  expect(el.textContent).not.toContain('继续抓取')
})

it('shows the options a link ran with, and continues it where the cap stopped', async () => {
  let continued = false
  const record = () => ({
    ...detail({ complete: 1000, partial: 0, failed: 0 }),
    done: !continued,
    options: {
      posts: 'until_existing',
      media_only: false,
      include_shared: true,
      capture_references: false,
      since_days: 30,
      relations: true,
    },
    ...(continued
      ? {}
      : {
          pages: { more: true, more_1000: true, capped: true, failed: false },
        }),
  })
  const sent: unknown[] = []
  mockApi((path, request) => {
    if (path === '/captures/record') return record()
    if (path.startsWith('/captures/record/members')) return { items: [] }
    if (path === '/captures/record/pages' && request.method === 'POST') {
      sent.push(JSON.parse(request.body!))
      continued = true
      return { id: 'job', collection_id: 'profile', state: 'queued' }
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      '选项抓到已有数据为止 · 不抓原帖 · 最近 30 天 · 抓关系网',
    ),
  )
  const button = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '继续抓取',
  )!
  button.click()
  await vi.waitFor(() => expect(sent).toEqual([{ op: 'continue' }]))
  await vi.waitFor(() => expect(el.textContent).not.toContain('继续抓取'))
})

it('a post shows only its references, and nothing with the defaults', async () => {
  const post = (references: boolean) => () => ({
    ...detail({}),
    kind: 'post',
    members: undefined,
    options: {
      posts: 'latest',
      count: 100,
      media_only: true,
      include_shared: true,
      capture_references: references,
      relations: false,
    },
  })
  const one = mount(
    post(false) as unknown as () => ReturnType<typeof detail>,
    {},
  )
  await vi.waitFor(() => expect(one.el.textContent).toContain('选项不抓原帖'))
  expect(one.el.textContent).not.toContain('仅媒体')
  unmount()
  unmount = () => {}
  document.body.replaceChildren()
  const two = mount(
    post(true) as unknown as () => ReturnType<typeof detail>,
    {},
  )
  await vi.waitFor(() => expect(two.el.textContent).toContain('提交时间'))
  expect(two.el.textContent).not.toContain('选项')
})

it('opens 账号 when it is the first tab, and heads it when it is the only one', async () => {
  const part = {
    collection_id: 'p1',
    url: 'https://x.com/i/user/1',
    handle: 'cat',
    state: 'complete',
  }
  const first = mount(
    () => ({
      ...detail({ complete: 2, partial: 0, failed: 0, added: 0, updated: 2 }),
      profiles: [part],
    }),
    { updated: [member('1'), member('2')] },
  )
  await vi.waitFor(() => expect(first.el.textContent).toContain('资料 ✓'))
  expect(first.tabs()).toEqual([
    { name: '账号 1', selected: true },
    { name: '更新记录 2', selected: false },
  ])
  // Nothing to load for it.
  expect(first.queried).toEqual([])
  first.click('更新记录')
  await vi.waitFor(() => expect(first.el.textContent).toContain('status/2'))
  expect(first.el.textContent).not.toContain('资料 ✓')
  unmount()
  unmount = () => {}
  document.body.replaceChildren()

  // A profile captured without its posts: its parts are all there is.
  const only = mount(
    () =>
      ({
        ...detail({}),
        members: undefined,
        profiles: [part],
      }) as never,
    {},
  )
  await vi.waitFor(() => expect(only.el.textContent).toContain('资料 ✓'))
  expect(only.tabs()).toEqual([])
  expect(only.el.querySelector('h2')?.textContent).toBe('账号')
})

it('says why a protected account has no posts, as a note rather than a failure, and keeps 重试本页', async () => {
  const note = '锁推账号，采集账号无权查看帖子（未关注或请求未通过）'
  const { el, tabs } = mount(
    () =>
      ({
        ...detail({ total: 0, complete: 0, partial: 0, failed: 0 }),
        error: note,
        pages: { more: false, more_1000: false, capped: false, failed: true },
        profiles: [
          {
            collection_id: 'profile',
            url: 'https://x.com/i/user/1',
            handle: 'Hang_Seng_Bank',
            state: 'complete',
            error: note,
            posts: {
              total: 0,
              finished: 0,
              pending: 0,
              done: true,
              capped: false,
              retryable: 0,
              retry_id: 'posts:record',
              pages: [],
            },
          },
        ],
      }) as never,
    {},
  )
  await vi.waitFor(() => expect(el.textContent).toContain(note))
  expect(tabs()).toEqual([])
  expect(el.textContent).toContain('@Hang_Seng_Bank资料 ✓ · 帖子 0')
  expect(el.querySelector('.state')?.textContent).toContain('已完成')
  expect(el.textContent).not.toContain('失败原因')
  expect(el.textContent).not.toContain('帖子获取中断')
  const labels = [...el.querySelectorAll('button')].map((b) =>
    b.textContent!.trim(),
  )
  expect(labels).toContain('重试本页')
  expect(labels).toContain('重新采集')
})

it("lists an update's skipped items one by one, each with why, among the problems", async () => {
  const skipped = (id: string, error: string, saved: boolean) => ({
    ...member(id, 'skipped'),
    job_id: `skipped:${id}`,
    saved,
    ...(saved ? { library_id: id } : {}),
    error,
  })
  const { el, tabs } = mount(
    () => ({
      ...detail({ complete: 1, partial: 0, failed: 0, added: 0, updated: 1 }),
      state: 'partial',
      update: {
        target: 'many',
        posts: 3,
        profiles: 0,
        older: false,
        queued: 0,
        skipped: 2,
      },
    }),
    {
      updated: [member('1')],
      problem: [
        skipped('2', '已移出收藏库', false),
        skipped('3', '没有可用的采集账号', true),
      ],
    },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([
    { name: '更新记录 1', selected: true },
    { name: '异常记录 2', selected: false },
  ])
  // Only a count up top: no summary of reasons.
  expect(el.textContent).toContain('跳过2 项')
  expect(el.textContent).not.toContain('已移出收藏库')
  ;[...el.querySelectorAll<HTMLElement>('[role=tab]')].at(-1)!.click()
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  const rows = [...el.querySelectorAll('.member')].map((row) => ({
    text: row.textContent,
    link: !!row.querySelector('a'),
    retry: !!row.querySelector('button'),
  }))
  expect(rows).toEqual([
    {
      text: expect.stringContaining('已移出收藏库已跳过'),
      link: false,
      retry: false,
    },
    {
      text: expect.stringContaining('没有可用的采集账号已跳过'),
      link: true,
      retry: false,
    },
  ])
})

it('names profile members by their stored name and handle, linked to the library or else the platform', async () => {
  const account = (id: string, patch: Record<string, unknown> = {}) => ({
    ...member(id),
    kind: 'profile',
    url: `https://x.com/i/user/${id}`,
    ...patch,
  })
  const { el } = mount(() => detail({ complete: 3, partial: 0, failed: 0 }), {
    '': [
      account('1546010181070249984', {
        handle: 'Raffel12310',
        name: 'Harel',
      }),
      // Saved by its handle, its account under its id: that one opens.
      account('2', {
        url: 'https://x.com/VueUse',
        handle: 'VueUse',
        name: 'VueUse',
        library_id: 'by-id',
      }),
      account('3', {
        state: 'failed',
        handle: 'cat',
        name: 'Cat',
        library_id: undefined,
      }),
    ],
  })
  await vi.waitFor(() => expect(el.textContent).toContain('Harel'))
  const rows = [...el.querySelectorAll('.member')].map((row) => ({
    text: row.querySelector('.line-text')!.firstChild!.textContent,
    href: row.querySelector('a')?.getAttribute('href'),
  }))
  expect(rows).toEqual([
    {
      text: 'Harel @Raffel12310',
      href: expect.stringMatching(/1546010181070249984$/),
    },
    { text: '@VueUse', href: expect.stringMatching(/by-id$/) },
    { text: 'Cat @cat', href: 'https://x.com/i/user/3' },
  ])
})

/** A profile record with something failed in each part. */
const failing = (retried: boolean) => ({
  ...detail({ complete: 1, partial: 1, failed: 2, added: 2, updated: 0 }),
  state: 'partial',
  retryable: retried ? 0 : 5,
  profiles: [
    {
      collection_id: 'p1',
      url: 'https://x.com/i/user/1',
      handle: 'cat',
      state: retried ? 'queued' : 'failed',
      job_id: 'profile-job',
      ...(retried ? {} : { retryable: true }),
      posts: {
        total: 4,
        finished: 4,
        pending: 0,
        done: true,
        capped: false,
        retryable: retried ? 0 : 3,
        retry_id: 'posts:record',
        pages: retried
          ? []
          : [{ id: 'page-2', number: 2, error: '时间线读取失败' }],
      },
      relations: [
        {
          id: 'following',
          list: 'following',
          state: retried ? 'running' : 'failed',
          fetched: 2,
          ...(retried ? {} : { error: '关注列表读取失败', retryable: true }),
        },
        {
          id: 'followers',
          list: 'followers',
          state: 'skipped',
          fetched: 0,
          error: '超过 5000 人，未抓取',
        },
      ],
    },
  ],
})

it('offers a retry next to each failed or incomplete part, and all at once', async () => {
  let retried = false
  const sent: unknown[] = []
  const problems = () => [
    { ...member('failed', 'failed'), ...(retried ? {} : { retryable: true }) },
    {
      ...member('partial', retried ? 'downloading' : 'partial'),
      ...(retried ? {} : { retryable: true }),
    },
    // The source reported it gone: nothing to fetch again.
    { ...member('gone', 'failed'), gone: true },
  ]
  mockApi((path, request) => {
    const url = new URL(path, 'http://localhost')
    if (url.pathname === '/captures/record') return failing(retried)
    if (url.pathname === '/captures/record/members')
      return {
        items: url.searchParams.get('state') === 'problem' ? problems() : [],
      }
    if (url.pathname === '/captures/record/retry-failed') {
      sent.push(JSON.parse(request.body!))
      retried = true
      return { count: 1 }
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  const buttons = () =>
    [...el.querySelectorAll('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent!.trim(),
    )
  const tab = (name: string) =>
    [...el.querySelectorAll<HTMLElement>('[role=tab]')]
      .find((t) => t.textContent!.startsWith(name))!
      .click()
  await vi.waitFor(() => expect(el.querySelector('[role=tab]')).not.toBeNull())
  tab('账号')
  await vi.waitFor(() => expect(el.textContent).toContain('帖子第 2 页'))
  expect(buttons()).toEqual(
    expect.arrayContaining([
      '全部重试',
      '重试 @cat 资料',
      '重试 @cat 帖子第 2 页',
      '重试 @cat 帖子',
      '重试 @cat 关注名单',
    ]),
  )
  // Skipped over 5000 is not a failure.
  expect(buttons()).not.toContain('重试 @cat 粉丝名单')
  tab('异常记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/gone'))
  expect(buttons()).toContain('重试 x.com/fixture/status/failed')
  expect(buttons()).toContain('重试 x.com/fixture/status/partial')
  expect(buttons()).not.toContain('重试 x.com/fixture/status/gone')

  tab('账号')
  await vi.waitFor(() => expect(el.textContent).toContain('帖子第 2 页'))
  el.querySelector<HTMLElement>('[aria-label="重试 @cat 帖子第 2 页"]')!.click()
  await vi.waitFor(() => expect(sent).toEqual([{ id: 'page-2' }]))
  // Retries under way show as running, with nothing left to retry.
  await vi.waitFor(() => expect(buttons()).not.toContain('全部重试'))
  expect(buttons().filter((b) => b.startsWith('重试'))).toEqual([])
  expect(el.textContent).toContain('资料 进行中')
  tab('异常记录')
  await vi.waitFor(() => expect(el.textContent).toContain('正在保存媒体'))
})

it('retries everything from the record, and a post its missing media', async () => {
  const sent: unknown[] = []
  mockApi((path, request) => {
    if (path === '/captures/record')
      return {
        ...detail({}),
        kind: 'post',
        state: 'partial',
        members: undefined,
        retryable: 1,
        media_retryable: true,
        media: { total: 2, ready: 1, failed: 1 },
        media_items: [
          { position: 0, kind: 'image', state: 'ready' },
          {
            position: 1,
            kind: 'video',
            state: 'failed',
            error: '媒体下载被中断',
          },
        ],
      }
    if (path === '/captures/record/retry-failed') {
      sent.push(JSON.parse(request.body!))
      return { count: 1 }
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  const press = async (label: string) => {
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    )!
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    button.click()
  }
  await vi.waitFor(() => expect(el.textContent).toContain('未保存的媒体'))
  await press('重试下载')
  await vi.waitFor(() => expect(sent).toEqual([{ id: 'job' }]))
  await press('全部重试')
  await vi.waitFor(() => expect(sent).toEqual([{ id: 'job' }, {}]))
})
