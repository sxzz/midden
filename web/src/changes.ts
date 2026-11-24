import type { Asset, ProfileChanges, ProfileFieldChange } from './api'

/** A changed text field: absent before when it was added, after when cleared. */
export interface TextLine {
  kind: 'text'
  key: string
  label: string
  before?: string
  after?: string
}
/** A changed image, shown small: round for an avatar, wide for a banner. */
export interface ImageLine {
  kind: 'image'
  key: string
  label: string
  shape: 'round' | 'wide'
  before?: Asset
  after?: Asset
}
/** Protection turned on or off, said in words. */
export interface FlagLine {
  kind: 'flag'
  key: string
  label: string
  locked: boolean
}
export type ChangeLine = TextLine | ImageLine | FlagLine

export interface ChangeEntry {
  id: string
  /** The capture's time, for a <time> element. */
  datetime: string
  /** Hours and minutes, under the day's heading. */
  time: string
  lines: ChangeLine[]
}
export interface ChangeDay {
  label: string
  entries: ChangeEntry[]
}

const labels: Record<
  Exclude<ProfileFieldChange['field'], 'protected'>,
  string
> = {
  name: '昵称',
  username: '用户名',
  bio: '简介',
  avatar: '头像',
  // As the capture records name the image.
  banner: '主页封面',
}

/** A field change in the words and shape the page shows it in. */
export function changeLine(change: ProfileFieldChange): ChangeLine {
  if (change.field === 'protected')
    return {
      kind: 'flag',
      key: change.field,
      label: change.after ? '设为受保护' : '取消受保护',
      locked: change.after,
    }
  if (change.field === 'avatar' || change.field === 'banner')
    return {
      kind: 'image',
      key: change.field,
      label: labels[change.field],
      shape: change.field === 'avatar' ? 'round' : 'wide',
      ...(change.before ? { before: change.before } : {}),
      ...(change.after ? { after: change.after } : {}),
    }
  // Handles read as the platform writes them.
  const prefix = change.field === 'username' ? '@' : ''
  const { before, after } = change
  return {
    kind: 'text',
    key: change.field,
    label: labels[change.field],
    ...(before ? { before: prefix + before } : {}),
    ...(after ? { after: prefix + after } : {}),
  }
}

/** What happened to a field that had or gained no value. */
export function lineNote(line: TextLine | ImageLine): string {
  if (!line.before) return '新增'
  if (!line.after) return line.kind === 'text' ? '清空' : '移除'
  return ''
}

const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** A day's heading: 今天, 昨天, or its date, with the year when not this one. */
export function dayLabel(d: Date, now = new Date()): string {
  const distance = Math.round((+day(now) - +day(d)) / 86_400_000)
  if (distance === 0) return '今天'
  if (distance === 1) return '昨天'
  const date = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear()
    ? date
    : `${d.getFullYear()}年${date}`
}

export const clock = (d: Date) =>
  `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`

/**
 * The changes as the page lists them: newest first, under a heading per day
 * in local time. An entry without a readable time is left out rather than
 * filed under a wrong day.
 */
export function changeDays(
  changes: ProfileChanges | undefined,
  now = new Date(),
): ChangeDay[] {
  const days: ChangeDay[] = []
  for (const item of changes?.items ?? []) {
    const at = new Date(item.observed_at)
    if (!Number.isFinite(at.getTime()) || !item.fields.length) continue
    const label = dayLabel(at, now)
    const entry: ChangeEntry = {
      id: item.revision_id,
      datetime: item.observed_at,
      time: clock(at),
      lines: item.fields.map(changeLine),
    }
    const last = days.at(-1)
    if (last?.label === label) last.entries.push(entry)
    else days.push({ label, entries: [entry] })
  }
  return days
}
