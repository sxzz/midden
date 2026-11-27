import type { QueueState, SlowQuery } from './api'

// 后台任务 (管理员面板): the words for the worker's job types and its state.

const TYPE_LABELS: Record<string, string> = {
  capture: '抓取',
  download: '下载媒体',
  upload: '上传媒体到R2',
  'raw-upload': '原始响应移到存储桶',
  related: '展开时间线',
  relations: '关系网名单',
  update: '更新',
  finalize: '保存版本',
}

export function jobTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

export interface QueueStatusText {
  label: string
  tone: 'ok' | 'active' | 'failed'
}

type Cause = NonNullable<NonNullable<QueueState['worker']>['cause']>

/** Why the worker lowered its concurrency, in a few words. */
export function throttleCause(cause: Cause): string {
  switch (cause.signal) {
    case 'web_lag':
      return `网页进程停顿${cause.value} ms`
    case 'web_slow':
      return `网页进程主线程上有${cause.value}个慢请求`
    case 'lock_wait':
      return `等待数据库写锁${cause.value} ms`
    case 'write_duty':
      return `后台写入占用写锁${cause.value}%的时间`
  }
}

/** One line: paused, stopped, slowed down (and why), or running. */
export function queueStatus(state: QueueState): QueueStatusText {
  if (state.control.paused) return { label: '已暂停', tone: 'active' }
  const { worker } = state
  if (!worker) return { label: '后台进程没有响应', tone: 'failed' }
  if (worker.held) return { label: '已停止领取任务', tone: 'failed' }
  if (worker.factor < 1) {
    const lowered = `运行中 · 已降低并发（${Math.round(worker.factor * 100)}%）`
    return {
      label: worker.cause
        ? `${lowered}：${throttleCause(worker.cause)}`
        : lowered,
      tone: 'active',
    }
  }
  return { label: worker.idle ? '空闲' : '运行中', tone: 'ok' }
}

export type RateLimit = QueueState['rate_limits'][number]

const PLATFORMS: Record<string, string> = {
  fxtwitter: 'FxTwitter公共接口',
  x: 'X',
  instagram: 'Instagram',
}

/** What is limited: FxTwitter 公共接口, X @foo · UserTweets, Instagram @foo. */
export function rateLimitName(limit: RateLimit): string {
  const platform = PLATFORMS[limit.platform] ?? limit.platform
  const name = limit.account ? `${platform} ${limit.account}` : platform
  return limit.endpoint ? `${name} · ${limit.endpoint}` : name
}

/** When it ends and how long that is: 11月26日 15:30 恢复，还有 12 分钟. */
export function rateLimitEnd(limit: RateLimit, now = new Date()): string {
  const until = new Date(limit.until)
  const time = `${until.getHours()}:${String(until.getMinutes()).padStart(2, '0')}`
  const at =
    until.toDateString() === now.toDateString()
      ? time
      : `${until.getMonth() + 1}月${until.getDate()}日 ${time}`
  const minutes = Math.ceil((+until - +now) / 60_000)
  const hours = Math.floor(minutes / 60)
  if (minutes <= 1) return `${at} 恢复，不到1分钟`
  const left =
    minutes < 60
      ? `${minutes}分钟`
      : `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`
  return `${at} 恢复，还有${left}`
}

/**
 * The web process's last minute: its requests, its event loop, and slow
 * requests by where they ran (only those on the main thread held up the
 * others; the read threads' never slow the worker down).
 */
export function webLatency(web: NonNullable<QueueState['web']>) {
  const { requests } = web
  return {
    requests: requests.count
      ? `${requests.count}个请求 · 中位${requests.p50_ms} ms · p95 ${requests.p95_ms} ms · 最长${requests.max_ms} ms`
      : '没有请求',
    lag: `事件循环最长停顿${web.lag_max_ms} ms`,
    ...(requests.slow || requests.slow_thread
      ? {
          slow: `超过500 ms：主线程${requests.slow}个，读线程${requests.slow_thread}个`,
        }
      : {}),
  }
}

/**
 * A slow query in one line and its query below: when (11-27 20:15:03, the
 * date left out today), the route, how long, the rows; the query or filter
 * it ran for, or its SQL when it has none.
 */
export function slowQueryText(query: SlowQuery, now = new Date()) {
  const at = new Date(query.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  const when =
    at.toDateString() === now.toDateString()
      ? time
      : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
  return {
    title: `${when} · ${query.route}`,
    figures: `${query.ms.toLocaleString('en-US')} ms · ${query.rows.toLocaleString('en-US')}行`,
    query: query.query || query.sql,
  }
}
