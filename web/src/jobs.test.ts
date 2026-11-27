import { describe, expect, test } from 'vitest'
import {
  jobTypeLabel,
  queueStatus,
  rateLimitEnd,
  rateLimitName,
  throttleCause,
  webLatency,
  type RateLimit,
} from './jobs'
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
  pausable: ['upload', 'raw-upload'],
  backlog: [],
  rate_limits: [],
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
    // And why.
    expect(
      queueStatus(
        state({
          worker: {
            ...worker,
            factor: 0.25,
            cause: { signal: 'lock_wait', value: 820 },
          },
        }),
      ).label,
    ).toBe('运行中 · 已降低并发（25%）：等待数据库写锁 820 ms')
    expect(queueStatus(state()).label).toBe('运行中')
    expect(
      queueStatus(state({ worker: { ...worker, idle: true } })).label,
    ).toBe('空闲')
  })

  test('each reason for slowing down has words', () => {
    expect(throttleCause({ signal: 'web_lag', value: 310 })).toBe(
      '网页进程停顿 310 ms',
    )
    expect(throttleCause({ signal: 'web_slow', value: 2 })).toBe(
      '网页进程主线程上有 2 个慢请求',
    )
    expect(throttleCause({ signal: 'write_duty', value: 70 })).toBe(
      '后台写入占用写锁 70% 的时间',
    )
  })

  test('job types have names; unknown ones show as they are', () => {
    expect(jobTypeLabel('raw-upload')).toBe('原始响应移到存储桶')
    expect(jobTypeLabel('later')).toBe('later')
  })

  test('a rate limit names what is limited and when it ends', () => {
    const limit = (over: Partial<RateLimit>): RateLimit => ({
      scope: 'fxtwitter:public',
      platform: 'fxtwitter',
      until: new Date(2026, 10, 26, 15, 30).toISOString(),
      since: new Date(2026, 10, 26, 15, 0).toISOString(),
      hits: 1,
      reason: 'HTTP 429',
      waiting: 2,
      ...over,
    })
    expect(rateLimitName(limit({}))).toBe('FxTwitter 公共接口')
    expect(
      rateLimitName(
        limit({ platform: 'x', account: '@me', endpoint: 'UserTweets' }),
      ),
    ).toBe('X @me · UserTweets')
    expect(
      rateLimitName(limit({ platform: 'instagram', account: '@me' })),
    ).toBe('Instagram @me')
    expect(rateLimitEnd(limit({}), new Date(2026, 10, 26, 15, 18))).toBe(
      '15:30 恢复，还有 12 分钟',
    )
    expect(rateLimitEnd(limit({}), new Date(2026, 10, 26, 15, 29, 30))).toBe(
      '15:30 恢复，不到 1 分钟',
    )
    expect(rateLimitEnd(limit({}), new Date(2026, 10, 25, 14, 0))).toBe(
      '11月26日 15:30 恢复，还有 25 小时 30 分钟',
    )
  })

  test('the web latency reads as two lines, three with slow requests', () => {
    const web = {
      window_s: 60,
      lag_p99_ms: 12,
      lag_max_ms: 40,
      requests: {
        count: 30,
        p50_ms: 3,
        p95_ms: 20,
        max_ms: 80,
        slow: 0,
        slow_thread: 0,
      },
    }
    expect(webLatency(web)).toEqual({
      requests: '30 个请求 · 中位 3 ms · p95 20 ms · 最长 80 ms',
      lag: '事件循环最长停顿 40 ms',
    })
    expect(
      webLatency({
        ...web,
        requests: { ...web.requests, max_ms: 7700, slow_thread: 3 },
      }).slow,
    ).toBe('超过 500 ms：主线程 0 个，读线程 3 个')
  })
})
