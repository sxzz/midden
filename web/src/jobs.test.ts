import { describe, expect, test } from 'vitest'
import { jobTypeLabel, queueStatus, webLatency } from './jobs'
import type { QueueState } from './api'

const worker: NonNullable<QueueState['worker']> = {
  reported_at: '2026-11-26T00:00:00.000Z',
  factor: 1,
  pressure: 'calm',
  running: { capture: 2 },
  limits: { capture: 4 },
  idle: false,
}
const state = (over: Partial<QueueState> = {}): QueueState => ({
  control: { paused: false, types: [] },
  pausable: ['thumbnail', 'upload', 'raw-upload'],
  backlog: [],
  worker,
  web: null,
  ...over,
})

describe('后台任务', () => {
  test('the status says paused, missing, slowed down or running', () => {
    expect(
      queueStatus(state({ control: { paused: true, types: [] } })).label,
    ).toBe('已暂停')
    expect(queueStatus(state({ worker: null }))).toEqual({
      label: '后台进程没有响应',
      tone: 'failed',
    })
    expect(
      queueStatus(state({ worker: { ...worker, factor: 0.5 } })).label,
    ).toBe('运行中 · 已降低并发（50%）')
    expect(queueStatus(state()).label).toBe('运行中')
    expect(
      queueStatus(state({ worker: { ...worker, idle: true } })).label,
    ).toBe('空闲')
  })

  test('job types have names; unknown ones show as they are', () => {
    expect(jobTypeLabel('raw-upload')).toBe('原始响应移到存储桶')
    expect(jobTypeLabel('later')).toBe('later')
  })

  test('the web latency reads as two lines', () => {
    expect(
      webLatency({
        window_s: 60,
        lag_p99_ms: 12,
        lag_max_ms: 40,
        requests: { count: 30, p50_ms: 3, p95_ms: 20, max_ms: 80, slow: 0 },
      }),
    ).toEqual({
      requests: '30 个请求 · 中位 3 ms · p95 20 ms · 最长 80 ms',
      lag: '事件循环最长停顿 40 ms',
    })
  })
})
