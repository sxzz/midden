import { expect, it } from 'vitest'
import {
  accountKey,
  fetchNote,
  perspectiveName,
  relationChip,
  relationQuery,
} from './relation-filter'

it('keys an account as the server keys an author', () => {
  expect(accountKey({ type: 'x.profile', external_id: '100' })).toBe(
    'x/x.profile/100',
  )
  expect(accountKey({ type: 'x.profile', external_id: 'a/b' })).toBe(
    'x/x.profile/a%2Fb',
  )
  expect(relationQuery('x/x.profile/100', 'mutual')).toEqual({
    entity_type: 'x.profile,instagram.profile',
    rel_of: 'x/x.profile/100',
    rel: 'mutual',
  })
})

it('names the filter by handle, else name, else id', () => {
  const key = 'x/x.profile/100'
  expect(perspectiveName(key, { name: '甲', username: 'foo' })).toBe('@foo')
  expect(perspectiveName(key, { name: '甲' })).toBe('甲')
  expect(perspectiveName(key)).toBe('100')
  expect(relationChip('following', '@foo')).toBe('@foo 关注的')
  expect(relationChip('followers', '@foo')).toBe('关注 @foo 的')
  expect(relationChip('mutual', '@foo')).toBe('@foo 互关')
})

it('notes how far the lists behind a mode were read', () => {
  const now = new Date('2026-11-25T12:00:00')
  const lists = {
    following: { complete_at: new Date('2026-11-20T12:00:00').toISOString() },
    followers: {},
  }
  expect(fetchNote(lists, 'following', now)).toBe('关注名单 11-20 完整抓取')
  expect(fetchNote(lists, 'followers', now)).toBe('粉丝名单未抓取')
  expect(fetchNote(lists, 'mutual', now)).toBe(
    '关注名单 11-20 完整抓取 · 粉丝名单未抓取',
  )
  expect(
    fetchNote(
      {
        following: {},
        followers: {
          partial_at: new Date('2025-03-05T12:00:00').toISOString(),
        },
      },
      'followers',
      now,
    ),
  ).toBe('粉丝名单 2025-03-05 部分抓取')
})
