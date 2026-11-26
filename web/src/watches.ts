import { optionsSummary } from './capture-options'
import { profileHandle, stateStatus, type RecordStatus } from './captures'
import type { Watch, WatchFrequency } from './api'

/** 定期更新: how often, in the order the menu lists them. */
export const frequencies: { value: WatchFrequency; label: string }[] = [
  { value: '6h', label: '每 6 小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
]

export const DEFAULT_FREQUENCY: WatchFrequency = 'daily'

export const frequencyLabel = (f: WatchFrequency) =>
  frequencies.find((item) => item.value === f)?.label ?? f

const day = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** A run's time in local time: 今天 09:05, 明天 21:30, 11月30日 09:05. */
export function runTime(value: string, now = new Date()) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.round((day(d) - day(now)) / 86_400_000)
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `明天 ${time}`
  if (days === -1) return `昨天 ${time}`
  const date = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear()
    ? `${date} ${time}`
    : `${d.getFullYear()}年${date} ${time}`
}

/** What a watch updates: @foo, or 收藏夹「猫」. */
export function watchTitle(w: Watch) {
  if (w.target === 'folder') return `收藏夹「${w.name ?? ''}」`
  return w.url ? profileHandle(w.url, w.handle) : (w.handle ?? '')
}

/** How often and with what, e.g. 每天 · 抓到已有数据为止 · 抓关系网. */
export function watchSummary(w: Watch) {
  return [
    frequencyLabel(w.frequency),
    optionsSummary(w.options, {
      profiles: true,
      posts: w.target === 'folder',
    }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How its last run went, as the record list says it. */
export function lastRunStatus(
  run: NonNullable<Watch['last_run']>,
): RecordStatus {
  if (!run.done && run.paused) return { label: '已暂停', tone: 'warn' }
  if (!run.done) return { label: '正在更新', tone: 'active' }
  if (run.stopped) return { label: '已中止', tone: 'warn' }
  return stateStatus(run.state as never)
}

/** The next run, or why there is none. */
export function nextRunText(w: Watch, now = new Date()) {
  if (!w.enabled) return '已关闭'
  return `下次 ${runTime(w.next_run_at, now)}`
}

/** The last run in a line: 上次 今天 03:12 · 已完成. */
export function lastRunText(w: Watch, now = new Date()) {
  if (!w.last_run) return ''
  return `上次 ${runTime(w.last_run.created_at, now)} · ${lastRunStatus(w.last_run).label}`
}
