import type { QueueState } from './api'

// 后台任务 (管理员面板): the words for the worker's job types and its state.

const TYPE_LABELS: Record<string, string> = {
  capture: '抓取',
  download: '下载媒体',
  thumbnail: '缩略图',
  upload: '上传媒体到 R2',
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

/** One line: paused, stopped, slowed down, or running. */
export function queueStatus(state: QueueState): QueueStatusText {
  if (state.control.paused) return { label: '已暂停', tone: 'active' }
  const { worker } = state
  if (!worker) return { label: '后台进程没有响应', tone: 'failed' }
  if (worker.held) return { label: '已停止领取任务', tone: 'failed' }
  if (worker.factor < 1)
    return {
      label: `运行中 · 已降低并发（${Math.round(worker.factor * 100)}%）`,
      tone: 'active',
    }
  return { label: worker.idle ? '空闲' : '运行中', tone: 'ok' }
}

/** The web process's last minute, as two lines. */
export function webLatency(web: NonNullable<QueueState['web']>) {
  const { requests } = web
  return {
    requests: requests.count
      ? `${requests.count} 个请求 · 中位 ${requests.p50_ms} ms · p95 ${requests.p95_ms} ms · 最长 ${requests.max_ms} ms`
      : '没有请求',
    lag: `事件循环最长停顿 ${web.lag_max_ms} ms`,
  }
}
