import { describe, expect, it } from 'vitest'
import {
  accountName,
  followDays,
  moment,
  relationsDone,
  relationsText,
} from './follows'
import type { FollowChange } from './api'

const now = new Date(2026, 10, 24, 12, 0)
const at = (day: number, hour: number) =>
  new Date(2026, 10, day, hour, 30).toISOString()
const change = (
  type: FollowChange['type'],
  id: string,
  observed: string,
  since?: string,
): FollowChange => ({
  type,
  observed_at: observed,
  ...(since ? { since } : {}),
  account: { entity_id: `e${id}`, external_id: id, name: `账号${id}` },
})

describe('follow changes', () => {
  it('groups changes by day, then by the fetch that saw them, then by kind', () => {
    const days = followDays(
      {
        items: [
          change('followed_by', '3', at(24, 9), at(23, 9)),
          change('follow', '2', at(24, 9), at(23, 9)),
          change('follow', '1', at(24, 9), at(22, 9)),
          change('unfollowed_by', '4', at(24, 9), at(23, 8)),
          change('unfollow', '5', at(22, 9), at(21, 9)),
        ],
      },
      now,
    )
    expect(days.map((d) => d.label)).toEqual(['今天', '11月22日'])
    const [entry] = days[0]!.entries
    expect(days[0]!.entries).toHaveLength(1)
    expect(entry!.time).toBe('9:30')
    // The account's own follows first, then others' follows of it.
    expect(entry!.lines.map((l) => [l.label, l.accounts.length])).toEqual([
      ['新关注', 2],
      ['新粉丝', 1],
      ['掉粉', 1],
    ])
    // A line's window starts where the earliest of its accounts' does.
    expect(entry!.lines[0]!.since).toBe(at(22, 9))
    expect(days[1]!.entries[0]!.lines[0]!.label).toBe('取关')
  })

  it('leaves out a change without a readable time, and says nothing of none', () => {
    expect(followDays(undefined)).toEqual([])
    expect(
      followDays({ items: [change('follow', '1', 'not a time')] }, now),
    ).toEqual([])
  })

  it('names times and accounts the way the page shows them', () => {
    expect(moment(at(23, 8), now)).toBe('昨天 8:30')
    expect(moment('', now)).toBe('')
    expect(
      accountName({ entity_id: 'e', external_id: '9', username: 'nine' }),
    ).toBe('@nine')
    expect(accountName({ entity_id: 'e', external_id: '9' })).toBe('ID 9')
  })
})

describe('list fetches', () => {
  it('says how each list went', () => {
    const lists = [
      { list: 'following', state: 'running', expected: 300, fetched: 120 },
      {
        list: 'followers',
        state: 'skipped',
        expected: 20_000,
        fetched: 0,
        error: '超过 5000 人，未抓取',
      },
    ] as const
    expect(relationsText(lists)).toBe(
      '关注 120/300 · 粉丝 超过 5000 人，未抓取',
    )
    expect(relationsDone(lists)).toBe(false)
    expect(
      relationsText([
        { list: 'following', state: 'complete', expected: 3, fetched: 3 },
        { list: 'followers', state: 'partial', expected: 30, fetched: 2 },
      ]),
    ).toBe('关注 3 人 · 粉丝 2/30，不完整')
    expect(
      relationsText([
        { list: 'following', state: 'failed', fetched: 0, error: '账号不可用' },
        { list: 'followers', state: 'waiting', fetched: 0 },
      ]),
    ).toBe('关注 失败：账号不可用 · 粉丝 等待中')
    expect(relationsDone(undefined)).toBe(true)
  })
})
