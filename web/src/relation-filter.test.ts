import { expect, it } from 'vitest'
import {
  accountKey,
  briefFetchNote,
  fetchNote,
  perspectiveName,
  relationChip,
  relationQuery,
  relMinOf,
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

it('names several accounts and how many of them', () => {
  expect(relationChip('following', ['@a', '@b', '@c'], 2)).toBe(
    '@a、@b、@c 中至少 2 人关注的',
  )
  expect(relationChip('followers', ['@a', '@b'], 2)).toBe(
    '关注 @a、@b 中至少 2 人的',
  )
  expect(relationChip('mutual', ['@a', '@b'], 1)).toBe(
    '与 @a、@b 中至少 1 人互关',
  )
  expect(relMinOf('3', 3)).toBe(3)
  expect(relMinOf('4', 3)).toBe(2)
  expect(relMinOf(null, 1)).toBe(1)
  expect(relMinOf('x', 5)).toBe(2)
  expect(relationQuery(['a', 'b'], 'following', 2)).toEqual({
    entity_type: 'x.profile,instagram.profile',
    rel_of: ['a', 'b'],
    rel: 'following',
  })
  expect(relationQuery(['a', 'b', 'c'], 'followers', 3)).toMatchObject({
    rel_min: '3',
  })
})

it('notes each of several accounts briefly', () => {
  const now = new Date('2026-11-25T12:00:00')
  const lists = {
    following: { complete_at: new Date('2026-11-20T12:00:00').toISOString() },
    followers: { partial_at: new Date('2026-11-21T12:00:00').toISOString() },
  }
  expect(briefFetchNote('@a', lists, 'following', now)).toBe(
    '@a 关注 11-20 完整',
  )
  expect(briefFetchNote('@a', lists, 'mutual', now)).toBe(
    '@a 关注 11-20 完整、粉丝 11-21 部分',
  )
  expect(
    briefFetchNote('@b', { following: {}, followers: {} }, 'followers', now),
  ).toBe('@b 粉丝未抓取')
})
