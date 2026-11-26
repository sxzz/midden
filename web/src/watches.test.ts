import { expect, test } from 'vitest'
import {
  lastRunText,
  nextRunText,
  runTime,
  watchSummary,
  watchTitle,
} from './watches'
import type { Watch } from './api'

const watch = (patch: Partial<Watch> = {}): Watch => ({
  id: 'w',
  target: 'collection',
  target_id: 'c',
  handle: 'cat',
  url: 'https://x.com/cat',
  frequency: 'daily',
  options: {
    posts: 'latest',
    count: 100,
    media_only: false,
    include_shared: true,
    capture_references: true,
    relations: false,
  },
  enabled: true,
  next_run_at: '2026-11-27T01:05:00',
  created_at: '2026-11-20T00:00:00',
  ...patch,
})

const now = new Date('2026-11-26T12:00:00')

test('run times read in local time, relative to today', () => {
  expect(runTime('2026-11-26T09:05:00', now)).toBe('今天 9:05')
  expect(runTime('2026-11-27T21:30:00', now)).toBe('明天 21:30')
  expect(runTime('2026-11-25T03:00:00', now)).toBe('昨天 3:00')
  expect(runTime('2026-12-03T09:05:00', now)).toBe('12月3日 9:05')
  expect(runTime('2027-01-02T09:05:00', now)).toBe('2027年1月2日 9:05')
})

test('a watch says what, how often and with what', () => {
  expect(watchTitle(watch())).toBe('@cat')
  expect(
    watchTitle(watch({ target: 'folder', name: '猫', url: undefined })),
  ).toBe('收藏夹「猫」')
  expect(watchSummary(watch())).toBe('每天 · 最新 100 条')
  expect(
    watchSummary(
      watch({
        frequency: '6h',
        options: {
          ...watch().options,
          posts: 'until_existing',
          relations: true,
        },
      }),
    ),
  ).toBe('每 6 小时 · 抓到已有数据为止 · 抓关系网')
  expect(
    watchSummary(
      watch({
        target: 'folder',
        frequency: 'weekly',
        options: { ...watch().options, capture_references: false },
      }),
    ),
  ).toBe('每周 · 不抓原帖')
})

test('its next and last run', () => {
  expect(nextRunText(watch(), now)).toBe('下次 明天 1:05')
  expect(nextRunText(watch({ enabled: false }), now)).toBe('已关闭')
  expect(lastRunText(watch(), now)).toBe('')
  const run = {
    id: 'u',
    state: 'queued',
    done: false,
    created_at: '2026-11-26T01:05:00',
  }
  expect(lastRunText(watch({ last_run: run }), now)).toBe(
    '上次 今天 1:05 · 正在更新',
  )
  expect(lastRunText(watch({ last_run: { ...run, paused: true } }), now)).toBe(
    '上次 今天 1:05 · 已暂停',
  )
  expect(
    lastRunText(
      watch({ last_run: { ...run, state: 'complete', done: true } }),
      now,
    ),
  ).toBe('上次 今天 1:05 · 已完成')
})
