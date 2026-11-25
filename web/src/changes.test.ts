import { expect, it } from 'vitest'
import {
  changeDays,
  changeLine,
  dayLabel,
  lineNote,
  postLabel,
} from './changes'
import { asset } from './testing/api'
import type { ProfileChange } from './api'

const old = asset({ id: 'old', purpose: 'avatar', sha256: 'a' })
const now = asset({ id: 'new', purpose: 'avatar', sha256: 'b' })

it('words each field the way the page names it', () => {
  expect(changeLine({ field: 'name', before: 'A', after: 'B' })).toEqual({
    kind: 'text',
    key: 'name',
    label: '昵称',
    before: 'A',
    after: 'B',
  })
  // Handles read with their @, as the detail page writes them.
  expect(changeLine({ field: 'username', before: 'a', after: 'b' })).toEqual(
    expect.objectContaining({ label: '用户名', before: '@a', after: '@b' }),
  )
  expect(changeLine({ field: 'bio', after: '新简介' })).toEqual({
    kind: 'text',
    key: 'bio',
    label: '简介',
    after: '新简介',
  })
  expect(
    changeLine({ field: 'protected', before: false, after: true }),
  ).toEqual({
    kind: 'flag',
    key: 'protected',
    label: '设为受保护',
    locked: true,
  })
  expect(
    changeLine({ field: 'protected', before: true, after: false }),
  ).toEqual({
    kind: 'flag',
    key: 'protected',
    label: '取消受保护',
    locked: false,
  })
  expect(changeLine({ field: 'avatar', before: old, after: now })).toEqual({
    kind: 'image',
    key: 'avatar',
    label: '头像',
    shape: 'round',
    before: old,
    after: now,
  })
  expect(changeLine({ field: 'banner', before: old })).toEqual({
    kind: 'image',
    key: 'banner',
    label: '主页封面',
    shape: 'wide',
    before: old,
  })
})

it('says when a field was added, cleared or removed', () => {
  const note = (change: Parameters<typeof changeLine>[0]) => {
    const line = changeLine(change)
    return line.kind === 'flag' ? undefined : lineNote(line)
  }
  expect(note({ field: 'bio', before: 'a', after: 'b' })).toBe('')
  expect(note({ field: 'bio', after: 'b' })).toBe('新增')
  expect(note({ field: 'bio', before: 'a' })).toBe('清空')
  expect(note({ field: 'banner', after: now })).toBe('新增')
  expect(note({ field: 'banner', before: old })).toBe('移除')
  const post = { id: '1' }
  expect(note({ field: 'pinned', before: [], after: [post] })).toBe('新增')
  expect(note({ field: 'pinned', before: [post], after: [] })).toBe('取消置顶')
  expect(note({ field: 'pinned', before: [post], after: [{ id: '2' }] })).toBe(
    '',
  )
})

it('reads a pinned post as its text, else its address', () => {
  expect(
    postLabel({ id: '1', text: '你好', url: 'https://x.com/i/web/status/1' }),
  ).toBe('你好')
  expect(postLabel({ id: '2', url: 'https://www.instagram.com/p/B/' })).toBe(
    'instagram.com/p/B/',
  )
  expect(postLabel({ id: '3' })).toBe('3')
})

it('heads days as today, yesterday, or their date', () => {
  const at = new Date(2026, 10, 24, 18)
  expect(dayLabel(new Date(2026, 10, 24, 0, 5), at)).toBe('今天')
  expect(dayLabel(new Date(2026, 10, 23, 23, 59), at)).toBe('昨天')
  expect(dayLabel(new Date(2026, 9, 3), at)).toBe('10月3日')
  expect(dayLabel(new Date(2025, 2, 2), at)).toBe('2025年3月2日')
})

it('files changes under their local day, newest first as given', () => {
  const change = (id: string, at: Date): ProfileChange => ({
    id,
    capture_id: `c-${id}`,
    revision_id: id,
    observed_at: at.toISOString(),
    fields: [{ field: 'name', before: 'A', after: 'B' }],
  })
  const today = new Date(2026, 10, 24, 18)
  const days = changeDays(
    {
      items: [
        change('r4', new Date(2026, 10, 24, 9, 5)),
        change('r3', new Date(2026, 10, 24, 0, 1)),
        // A time that cannot be read is not filed under a wrong day.
        { ...change('bad', today), observed_at: 'soon' },
        change('r2', new Date(2026, 10, 23, 23, 59)),
        change('r1', new Date(2025, 2, 2, 12)),
      ],
    },
    today,
  )
  expect(
    days.map((day) => [
      day.label,
      day.entries.map((entry) => [entry.id, entry.time]),
    ]),
  ).toEqual([
    [
      '今天',
      [
        ['r4', '9:05'],
        ['r3', '0:01'],
      ],
    ],
    ['昨天', [['r2', '23:59']]],
    ['2025年3月2日', [['r1', '12:00']]],
  ])
  expect(days[0]!.entries[0]!.datetime).toBe(
    new Date(2026, 10, 24, 9, 5).toISOString(),
  )
  expect(changeDays(undefined)).toEqual([])
})

it('names the day an account was suspended or gone, and when it was back', () => {
  const now = new Date(2026, 10, 24, 18)
  const line = (state: 'deleted' | 'suspended', ended: boolean, at: Date) =>
    changeLine({ field: 'state', state, ended }, at, now)
  expect(line('suspended', false, new Date(2026, 10, 5))).toMatchObject({
    kind: 'flag',
    label: '11月5日起账号被封禁',
  })
  expect(line('suspended', true, new Date(2026, 10, 20)).label).toBe(
    '11月20日解封',
  )
  expect(line('deleted', false, new Date(2025, 0, 2)).label).toBe(
    '2025年1月2日起账号已不存在',
  )
  expect(line('deleted', true, new Date(2026, 10, 20)).label).toBe(
    '11月20日账号恢复',
  )
})
