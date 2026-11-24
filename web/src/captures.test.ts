import { expect, test } from 'vitest'
import {
  countText,
  coverText,
  extractLinks,
  groupRecords,
  linkTitle,
  mediaLabel,
  profileHandle,
  profilePartText,
  recordAdditions,
  recordCounts,
  recordProgress,
  recordRowTime,
  recordStatus,
  recordTitle,
} from './captures'
import type { CaptureRecord, UpdateInfo } from './api'

const record = (patch: Partial<CaptureRecord>): CaptureRecord => ({
  id: 'r',
  job_id: 'j',
  collection_id: 'c',
  saved: true,
  url: 'https://x.com/fixture/status/1',
  input: 'https://x.com/fixture/status/1',
  platform: 'x',
  kind: 'post',
  state: 'queued',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-10-14T08:00:00Z',
  done: false,
  ...patch,
})

test('extracts links from pasted text', () => {
  expect(
    extractLinks(
      '看这个 https://fxtwitter.com/a/status/1?s=20, 还有\nfixupx.com/b/status/2 。\nhttps://fxtwitter.com/a/status/1?s=20 无关文字 a.b',
    ),
  ).toEqual([
    'https://fxtwitter.com/a/status/1?s=20',
    'https://fixupx.com/b/status/2',
  ])
  expect(extractLinks('没有链接')).toEqual([])
})

test('titles a link without scheme and query', () => {
  expect(linkTitle('https://www.x.com/fixture/status/1/?s=20')).toBe(
    'x.com/fixture/status/1',
  )
})

test('a post reports its own capture and media', () => {
  const downloading = record({
    state: 'downloading',
    media: { total: 4, ready: 1, failed: 1 },
  })
  expect(recordStatus(downloading).label).toBe('正在保存媒体')
  expect(recordProgress(downloading)).toBe(0.5)
  expect(recordCounts(downloading)).toBe('媒体 1/4 · 失败 1')
  expect(recordProgress(record({}))).toBeUndefined()
  // Queued until the fetch is stored, so only `waiting` means it waits.
  expect(recordStatus(record({})).label).toBe('正在采集')
  expect(recordStatus(record({ waiting: 'queue' })).label).toBe('排队中')
  expect(recordStatus(record({ waiting: 'retry' })).label).toBe('等待重试')
  expect(recordStatus(record({ state: 'failed', done: true }))).toEqual({
    label: '失败',
    tone: 'failed',
  })
})

test('a collection follows its members after its own capture ends', () => {
  const members = {
    total: 10,
    complete: 3,
    partial: 1,
    failed: 2,
    pending: 4,
    done: false,
  }
  const running = record({ kind: 'profile', state: 'complete', members })
  expect(recordStatus(running)).toEqual({
    label: '正在保存帖子',
    tone: 'active',
  })
  expect(recordProgress(running)).toBe(0.6)
  expect(recordCounts(running)).toBe('帖子 6/10 · 不完整 1 · 失败 2')
  const finished = record({
    kind: 'profile',
    state: 'complete',
    done: true,
    members: { ...members, complete: 7, pending: 0, done: true },
  })
  expect(recordStatus(finished).label).toBe('部分缺失')
  expect(recordStatus({ ...finished, stopped: true }).label).toBe('已中止')
  expect(
    recordStatus(
      record({
        state: 'complete',
        done: true,
        members: {
          ...members,
          complete: 10,
          partial: 0,
          failed: 0,
          pending: 0,
        },
      }),
    ).label,
  ).toBe('已完成')
})

test('says which saved posts were new to the library', () => {
  const members = {
    total: 120,
    complete: 118,
    partial: 2,
    failed: 0,
    pending: 0,
    done: true,
  }
  const profile = (
    patch: Partial<typeof members & { added: number; updated: number }>,
  ) =>
    record({
      kind: 'profile',
      state: 'complete',
      done: true,
      members: { ...members, ...patch },
    })
  const known = profile({ added: 30, updated: 90 })
  expect(recordCounts(known)).toBe(
    '帖子 120/120 · 新增 30 · 更新 90 · 不完整 2',
  )
  expect(recordAdditions(known)).toBe('新增 30，更新 90')
  expect(recordCounts(profile({ added: 0, updated: 120 }))).toBe(
    '帖子 120/120 · 更新 120 · 不完整 2',
  )
  expect(recordAdditions(profile({ added: 0, updated: 120 }))).toBe(
    '新增 0，更新 120',
  )
  // Older records do not know: nothing rather than a guess.
  expect(recordCounts(profile({}))).toBe('帖子 120/120 · 不完整 2')
  expect(recordAdditions(profile({}))).toBe('')

  const post = record({
    state: 'complete',
    done: true,
    media: { total: 2, ready: 2, failed: 0 },
  })
  expect(recordCounts({ ...post, added: true })).toBe('新增 · 媒体 2/2')
  expect(
    recordCounts({
      ...post,
      added: false,
      media: { total: 0, ready: 0, failed: 0 },
    }),
  ).toBe('更新')
  expect(recordAdditions({ ...post, added: false })).toBe('更新了已有收藏')
  expect(recordCounts(post)).toBe('媒体 2/2')
  expect(recordAdditions(post)).toBe('')
})

test('names profile images by what they are', () => {
  const media = { kind: 'image', state: 'ready' } as const
  expect(mediaLabel({ ...media, position: 0, purpose: 'avatar' })).toBe('头像')
  expect(mediaLabel({ ...media, position: 1, purpose: 'banner' })).toBe(
    '主页封面',
  )
  expect(mediaLabel({ ...media, position: 2 })).toBe('图片 3')
  expect(mediaLabel({ ...media, position: 3, kind: 'video' })).toBe('视频 4')
})

test('groups records by day like the library, with times under them', () => {
  const now = new Date(2026, 9, 15, 12)
  const at = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(y, m, d, h, min).toISOString()
  const items = [
    record({ id: 'a', created_at: at(2026, 9, 15, 9, 5) }),
    record({ id: 'b', created_at: at(2026, 9, 14, 23, 0) }),
    record({ id: 'c', created_at: at(2026, 9, 2, 8, 30) }),
    record({ id: 'd', created_at: at(2025, 11, 31, 20, 0) }),
  ]
  expect(
    groupRecords(items, now).map((g) => [g.label, g.items.map((r) => r.id)]),
  ).toEqual([
    ['今天', ['a']],
    ['昨天', ['b']],
    ['10月', ['c']],
    ['2025年12月', ['d']],
  ])
  expect(recordRowTime(items[0].created_at, now)).toBe('9:05')
  expect(recordRowTime(items[1].created_at, now)).toBe('23:00')
  expect(recordRowTime(items[2].created_at, now)).toBe('10月2日 8:30')
})

test('a profile record runs on while its lists are fetched', () => {
  const members = {
    total: 2,
    complete: 2,
    partial: 0,
    failed: 0,
    pending: 0,
    done: true,
  }
  const fetching = record({
    kind: 'profile',
    state: 'complete',
    members,
    relations: [
      { list: 'following', state: 'running', expected: 30, fetched: 10 },
      { list: 'followers', state: 'waiting', fetched: 0 },
    ],
  })
  expect(recordStatus(fetching)).toEqual({
    label: '正在抓关系网',
    tone: 'active',
  })
  // The posts are all in; the lists have no share to show.
  expect(recordProgress(fetching)).toBeUndefined()
  const posts = record({
    kind: 'profile',
    state: 'complete',
    members: { ...members, pending: 1, complete: 1, done: false },
  })
  expect(recordStatus(posts).label).toBe('正在保存帖子')
})

const update = (patch: Partial<UpdateInfo>): UpdateInfo => ({
  target: 'collection',
  posts: 0,
  profiles: 1,
  options: { posts: 'latest', relations: false },
  queued: 0,
  skipped: 0,
  ...patch,
})

test('an update is titled by what it covers', () => {
  const profile = record({
    url: 'https://x.com/i/user/1',
    kind: 'profile',
    update: update({ handle: 'cat' }),
  })
  expect(recordTitle(profile)).toBe('更新 @cat')
  expect(
    recordTitle({
      ...profile,
      update: update({
        handle: 'cat',
        options: { posts: 'older', relations: false },
      }),
    }),
  ).toBe('抓取 @cat 更早的帖子')
  expect(
    recordTitle(record({ update: update({ posts: 1, profiles: 0 }) })),
  ).toBe('更新 x.com/fixture/status/1')
  expect(
    recordTitle(
      record({ url: '', update: update({ target: 'folder', name: '猫' }) }),
    ),
  ).toBe('更新收藏夹「猫」')
  expect(
    recordTitle(
      record({
        url: '',
        update: update({ target: 'many', posts: 9, profiles: 3 }),
      }),
    ),
  ).toBe('更新 12 项')
  expect(profileHandle('https://www.instagram.com/dog/')).toBe('@dog')
  expect(coverText(340, 12)).toBe('12 个账号、340 条帖子')
  expect(coverText(1, 0)).toBe('1 条帖子')
  expect(countText(320)).toBe('320')
  expect(countText(21_000)).toBe('2.1 万')
  expect(countText(10_049)).toBe('1 万')
})

test('an update counts every member, waiting items as running', () => {
  const running = record({
    update: update({ target: 'many', queued: 2 }),
    members: {
      total: 10,
      complete: 4,
      partial: 1,
      failed: 1,
      pending: 2,
      done: false,
      added: 3,
      updated: 2,
    },
  })
  expect(recordStatus(running)).toEqual({ label: '正在更新', tone: 'active' })
  expect(recordCounts(running)).toBe('新增 3 · 更新 2 · 异常 2 · 进行中 4')
  expect(recordProgress(running)).toBe(0.6)
  expect(recordStatus({ ...running, done: true, state: 'partial' })).toEqual({
    label: '部分缺失',
    tone: 'warn',
  })
})

test('a profile of an update tells how each part went', () => {
  const part = {
    collection_id: 'p',
    url: 'https://x.com/i/user/1',
    state: 'complete',
    posts: { total: 100, finished: 34, pending: 66, done: false },
    relations: [
      { list: 'following' as const, state: 'complete' as const, fetched: 3 },
      {
        list: 'followers' as const,
        state: 'skipped' as const,
        fetched: 0,
        expected: 6000,
      },
    ],
  }
  expect(profilePartText(part)).toBe(
    '资料 ✓ · 帖子 34/100 · 关注 ✓ · 粉丝 跳过',
  )
  expect(
    profilePartText({
      ...part,
      state: 'queued',
      posts: { total: 0, finished: 0, pending: 0, done: false },
      relations: [
        { list: 'following', state: 'waiting', fetched: 0 },
        { list: 'followers', state: 'failed', fetched: 0 },
      ],
    }),
  ).toBe('资料 进行中 · 帖子 0/0 · 关注 进行中 · 粉丝 失败')
  expect(
    profilePartText({
      collection_id: 'p',
      url: '',
      state: 'complete',
      posts: { total: 40, finished: 40, pending: 0, done: true },
    }),
  ).toBe('资料 ✓ · 帖子 40')
})
