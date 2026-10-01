import { expect, it } from 'vitest'
import { safeURL, type Collection } from './api'
import {
  groupCollections,
  mentionParts,
  present,
  shortDate,
  warningList,
} from './presentation'
it('does not expose executable original URLs', () => {
  expect(safeURL('javascript:alert(1)')).toBeUndefined()
  expect(safeURL('https://example.test/post')).toBe('https://example.test/post')
})
it('uses the revision profile snapshot', () => {
  const a = {
    text: 'text',
    author_name: 'Saved name',
    graph: {
      root: 'p',
      relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
      entities: [
        { key: 'p', type: 'x.post', data: {} },
        { key: 'u', type: 'x.profile', data: { username: 'saved_handle' } },
      ],
    },
  } as Collection
  expect(present(a).handle).toBe('saved_handle')
})
const xPost = (data: Record<string, unknown>, metadata: unknown) =>
  ({
    text: 'text',
    visibility: 'public',
    graph: {
      root: 'p',
      relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
      entities: [
        { key: 'p', type: 'x.post', data },
        { key: 'u', type: 'x.profile', data: { username: 'handle', metadata } },
      ],
    },
  }) as Collection
it('counts the account only where the account is the subject', () => {
  const metadata = { followers: 1234, likes: 56 }
  expect(present(xPost({}, metadata)).stats).toBeUndefined()
  const profile: Collection = {
    ...xPost({}, metadata),
    graph: {
      root: 'u',
      relations: [],
      entities: [
        { key: 'u', type: 'x.profile', data: { username: 'handle', metadata } },
      ],
    },
  }
  expect(present(profile).stats).toEqual({
    label: '账号统计',
    items: [
      { label: '关注者', value: '1,234' },
      { label: '喜欢过', value: '56' },
    ],
  })
})
it('counts a post from the post, keeping zero and dropping non-counts', () => {
  const a = xPost(
    { replies: 0, reposts: 12, likes: 3456, bookmarks: -1, quotes: 1.5 },
    { followers: 1234, likes: 56 },
  )
  expect(present(a).stats).toEqual({
    label: '帖子统计',
    items: [
      { label: '回复', value: '0' },
      { label: '转发', value: '12' },
      { label: '点赞', value: '3,456' },
    ],
  })
})
it('counts each revision from the entity data it was handed', () => {
  const likes = (value: number) => present(xPost({ likes: value }, {})).stats
  expect(likes(3)?.items).toEqual([{ label: '点赞', value: '3' }])
  expect(likes(9)?.items).toEqual([{ label: '点赞', value: '9' }])
})
it('details the post from its own record', () => {
  const a = xPost(
    { published_at: '2026-09-28T02:00:00Z', edited_at: '2026-09-28T03:00:00Z' },
    {},
  )
  expect(present(a).details.map((d) => [d.key, d.label])).toEqual([
    ['published', '发布于'],
    ['edited', '已编辑'],
  ])
  expect(present({ visibility: 'private' } as Collection).details).toEqual([
    { key: 'visibility', label: '可见性', value: '私密' },
  ])
})
it('buckets the collection by when it was saved', () => {
  const now = new Date(2026, 8, 29, 12, 0)
  const at = (y: number, m: number, d: number) =>
    ({
      id: `${y}-${m}-${d}`,
      saved_at: new Date(y, m, d, 9).toISOString(),
    }) as Collection
  const groups = groupCollections(
    [at(2026, 8, 29), at(2026, 8, 28), at(2026, 8, 12), at(2025, 10, 3)],
    now,
  )
  expect(groups.map((g) => g.label)).toEqual([
    '今天',
    '昨天',
    '9月',
    '2025年11月',
  ])
  expect(groups[0].items).toHaveLength(1)
})
it('writes list timestamps the way the chat list does', () => {
  const now = new Date(2026, 8, 29, 12, 0)
  expect(shortDate(new Date(2026, 8, 29, 8, 5).toISOString(), now)).toBe('8:05')
  expect(shortDate(new Date(2026, 8, 28, 8, 5).toISOString(), now)).toBe('昨天')
  expect(shortDate(new Date(2026, 0, 3, 8, 5).toISOString(), now)).toBe(
    '1月3日',
  )
  expect(shortDate(new Date(2025, 0, 3, 8, 5).toISOString(), now)).toBe(
    '2025年1月3日',
  )
  expect(shortDate(undefined, now)).toBe('')
})
it('translates adapter warnings and drops duplicates', () => {
  expect(
    warningList([
      'resource omitted: unsupported type or resource limit',
      'resource omitted: unsupported type or resource limit',
      'some adapter detail',
    ]),
  ).toEqual(['部分媒体超出限制，没有保存。', '部分内容没有完整保存。'])
})

const xProfile = (description?: string): Collection => ({
  ...xPost({}, {}),
  id: '06a4fde7-5a04-4c6f-b9e7-9cc99485900d',
  revision_id: 'different-revision',
  text: '@handle\nBio mentions @friend',
  graph: {
    root: 'u',
    relations: [],
    entities: [
      {
        key: 'u',
        type: 'x.profile',
        external_id: '1234567890123456789',
        data: { username: 'handle', metadata: { description } },
      },
    ],
  },
})
it('shows the saved bio without the synthetic handle prefix', () => {
  expect(present(xProfile('Actual bio with @handle')).body).toBe(
    'Actual bio with @handle',
  )
  expect(present(xProfile('')).body).toBe('暂无简介')
  expect(present(xProfile()).body).toBe('Bio mentions @friend')
  expect(
    present({ ...xProfile(), text: '@handle is part of this bio' }).body,
  ).toBe('@handle is part of this bio')
})
it('shows the exact profile UID and collection UUID in metadata', () => {
  const profile = xProfile()
  expect(present(profile).details).toEqual([
    { key: 'uid', label: 'UID', value: '1234567890123456789' },
    { key: 'uuid', label: 'UUID', value: profile.id },
  ])
  const post = {
    ...xPost({}, {}),
    id: 'post-collection',
    revision_id: 'post-revision',
  }
  expect(present(post).details).toEqual([
    { key: 'uuid', label: 'UUID', value: 'post-collection' },
  ])
  expect(present(post).body).toBe('text')
})

it('links saved mention identities without linking emails or unsaved profiles', () => {
  const collection = xProfile()
  collection.graph!.entities.push(
    {
      key: 'friend',
      type: 'x.profile',
      data: { username: 'Friend' },
      saved_collection_id: 'friend-id',
    },
    { key: 'unknown', type: 'x.profile', data: { username: 'unknown' } },
  )
  expect(
    mentionParts(collection, 'Hello @FRIEND! @unknown mail@friend.test'),
  ).toEqual([
    { text: 'Hello ' },
    { text: '@FRIEND', href: '#/collection/friend-id' },
    { text: '! @unknown mail@friend.test' },
  ])
})
