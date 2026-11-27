import { clock, dayLabel } from './changes'
import type {
  FollowAccount,
  FollowChange,
  FollowChanges,
  RelationProgress,
} from './api'

type ChangeType = FollowChange['type']

/** How a list fetch went, as the texts read it; the id only names it. */
export type ListProgress = Omit<RelationProgress, 'id' | 'retryable'>

/** In the order a time's changes are listed: the account's own, then others'. */
const order: ChangeType[] = [
  'follow',
  'unfollow',
  'followed_by',
  'unfollowed_by',
]

export const changeLabels: Record<ChangeType, string> = {
  follow: '新关注',
  unfollow: '取关',
  followed_by: '新粉丝',
  unfollowed_by: '掉粉',
}

/** One kind of change seen at one time, with the accounts it concerns. */
export interface FollowLine {
  type: ChangeType
  label: string
  /**
   * When the change was last known not to have happened yet: it happened
   * between then and the entry's time. Empty when unknown.
   */
  since: string
  accounts: FollowAccount[]
}

export interface FollowEntry {
  id: string
  datetime: string
  time: string
  lines: FollowLine[]
}

export interface FollowDay {
  label: string
  entries: FollowEntry[]
}

/** A time as the page names it: its day (今天, 昨天, a date) and clock. */
export function moment(value: string, now = new Date()): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  return `${dayLabel(d, now)} ${clock(d)}`
}

/**
 * The changes as the page lists them: newest first under a heading per day
 * in local time, one entry per time a fetch saw them, one line per kind.
 * A line's window starts at the earliest `since` among its accounts, so it
 * covers each of them.
 */
export function followDays(
  changes: FollowChanges | undefined,
  now = new Date(),
): FollowDay[] {
  const days: FollowDay[] = []
  for (const item of changes?.items ?? []) {
    const at = new Date(item.observed_at)
    if (!Number.isFinite(at.getTime())) continue
    const label = dayLabel(at, now)
    let day = days.at(-1)
    if (day?.label !== label) days.push((day = { label, entries: [] }))
    let entry = day.entries.at(-1)
    if (entry?.datetime !== item.observed_at)
      day.entries.push(
        (entry = {
          id: item.observed_at,
          datetime: item.observed_at,
          time: clock(at),
          lines: [],
        }),
      )
    let line = entry.lines.find((l) => l.type === item.type)
    if (!line) {
      line = {
        type: item.type,
        label: changeLabels[item.type],
        since: item.since ?? '',
        accounts: [],
      }
      entry.lines.push(line)
      entry.lines.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    }
    if (item.since && (!line.since || item.since < line.since))
      line.since = item.since
    line.accounts.push(item.account)
  }
  return days
}

/** An account as a line names it: its name, else its handle, else its id. */
export function accountName(account: FollowAccount): string {
  return (
    account.name ||
    (account.username ? `@${account.username}` : `ID ${account.external_id}`)
  )
}

const lists: Record<RelationProgress['list'], string> = {
  following: '关注',
  followers: '粉丝',
}

/** How one list fetch went, in a few words. */
function listText(item: ListProgress): string {
  const total = item.expected === undefined ? '' : `/${item.expected}`
  switch (item.state) {
    case 'waiting':
      return '等待中'
    case 'running':
      return `${item.fetched}${total}${item.rate_limited ? '，限流中' : ''}`
    case 'complete':
      return `${item.fetched}人`
    case 'partial':
      return `${item.fetched}${total}，不完整`
    case 'skipped':
      return item.error || '未抓取'
    default:
      return item.error ? `失败：${item.error}` : '失败'
  }
}

/** The lists a capture fetched, e.g. 关注 120/300 · 粉丝 超过 5000 人，未抓取. */
export function relationsText(items: readonly ListProgress[]): string {
  return items
    .map((item) => `${lists[item.list]} ${listText(item)}`)
    .join(' · ')
}

export const relationsDone = (items: readonly ListProgress[] = []) =>
  items.every((item) => item.state !== 'waiting' && item.state !== 'running')
