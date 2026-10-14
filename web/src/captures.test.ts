import { expect, test } from 'vitest'
import {
  extractLinks,
  groupRecords,
  linkTitle,
  mediaLabel,
  reasonText,
  recordCounts,
  recordProgress,
  recordRowTime,
  recordStatus,
} from './captures'
import type { CaptureRecord } from './api'

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

test('words known failure reasons and keeps unknown ones', () => {
  expect(reasonText('post not found or deleted')).toBe('帖子不存在或已删除')
  expect(reasonText('Instagram requires browser verification')).toMatch(
    /登录验证/,
  )
  expect(reasonText('upstream said no')).toBe('upstream said no')
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
