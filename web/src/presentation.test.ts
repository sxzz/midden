import { expect, it } from 'vitest'
import { safeURL, type Collection, type Entity } from './api'
import {
  groupCollections,
  mentionParts,
  present,
  shortDate,
  sourceStateNotice,
  warningList,
} from './presentation'
import { asset, collection, entity } from './testing/api'
it('keeps captionless social posts empty without using their author summary', () => {
  for (const type of ['x.post', 'instagram.post']) {
    const a = collection({
      id: 'captionless',
      url: 'https://example.test/post',
      observed_at: '2026-10-11T00:00:00Z',
      revision_id: 'r1',
      assets: [],
      text: '',
      summary: '作者：图片或视频',
      author_name: '作者',
      graph: {
        root: 'post',
        entities: [entity({ key: 'post', type })],
        relations: [],
      },
    })
    expect(present(a).body).toBe('')
    expect(present({ ...a, text: ' \n ' }).body).toBe('')
    expect(present({ ...a, text: '原帖正文' }).body).toBe('原帖正文')
  }
})
it('presents Instagram profiles, comments, dotted mentions, and absent counts', () => {
  const a = collection({
    id: 'instagram-post',
    url: 'https://www.instagram.com/p/C/',
    observed_at: '2026-10-01T00:00:00Z',
    revision_id: 'r1',
    assets: [],
    text: 'Hello @fixture.name',
    graph: {
      root: 'post',
      relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
      entities: [
        entity({
          key: 'post',
          type: 'instagram.post',
          data: { text: 'Hello @fixture.name', replies: 0, likes: 3 },
        }),
        entity({
          key: 'author',
          type: 'instagram.profile',
          external_id: '77',
          saved_collection_id: 'saved-profile',
          data: {
            username: 'fixture.name',
            name: 'Instagram Fixture',
            metadata: {
              description: 'Bio',
              protected: true,
              followers: 5,
              following: 2,
              statuses: 1,
            },
          },
        }),
      ],
    },
  })
  const presentation = present(a)
  expect(presentation.name).toBe('Instagram Fixture')
  expect(presentation.locked).toBe(true)
  expect(presentation.profileCollectionId).toBe('saved-profile')
  expect(presentation.stats?.items).toEqual([
    { label: '评论', value: '0' },
    { label: '点赞', value: '3' },
  ])
  expect(mentionParts(a, a.text)).toEqual([
    { text: 'Hello ' },
    { text: '@fixture.name', href: '#/collection/saved-profile' },
  ])
  const profile = { ...a, text: 'Bio', graph: { ...a.graph!, root: 'author' } }
  expect(present(profile).body).toBe('Bio')
  expect(present(profile).stats?.items.map((item) => item.label)).toEqual([
    '关注者',
    '正在关注',
    '帖子',
  ])
  a.graph!.entities[0]!.data = { text: 'Hello' }
  expect(present(a).stats).toBeUndefined()
})
it('does not expose executable original URLs', () => {
  expect(safeURL('javascript:alert(1)')).toBeUndefined()
  expect(safeURL('https://example.test/post')).toBe('https://example.test/post')
})
it('uses the revision profile snapshot', () => {
  const a = collection({
    text: 'text',
    author_name: 'Saved name',
    graph: {
      root: 'p',
      relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
      entities: [
        entity({ key: 'p', type: 'x.post', data: {} }),
        entity({
          key: 'u',
          type: 'x.profile',
          data: { username: 'saved_handle' },
        }),
      ],
    },
  })
  expect(present(a).handle).toBe('saved_handle')
})
const xPost = (data: Entity['data'], metadata: Entity['data'][string]) =>
  collection({
    text: 'text',
    graph: {
      root: 'p',
      relations: [{ source: 'p', target: 'u', type: 'authored_by' }],
      entities: [
        entity({ key: 'p', type: 'x.post', data }),
        entity({
          key: 'u',
          type: 'x.profile',
          data: { username: 'handle', metadata },
        }),
      ],
    },
  })
it('counts the account only where the account is the subject', () => {
  const metadata = { followers: 1234, likes: 56 }
  expect(present(xPost({}, metadata)).stats).toBeUndefined()
  const profile: Collection = {
    ...xPost({}, metadata),
    graph: {
      root: 'u',
      relations: [],
      entities: [
        entity({
          key: 'u',
          type: 'x.profile',
          data: { username: 'handle', metadata },
        }),
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
    ['uuid', 'UUID'],
  ])
})
it('buckets the collection by when it was saved', () => {
  const now = new Date(2026, 8, 29, 12, 0)
  const at = (y: number, m: number, d: number) =>
    collection({
      id: `${y}-${m}-${d}`,
      saved_at: new Date(y, m, d, 9).toISOString(),
    })
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
it('shows warnings as written, once each', () => {
  expect(
    warningList([
      '部分资源类型不支持或资源数量超过限制',
      '部分资源类型不支持或资源数量超过限制',
      '帖子获取中断。',
    ]),
  ).toEqual(['部分资源类型不支持或资源数量超过限制', '帖子获取中断。'])
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
      entity({
        key: 'u',
        type: 'x.profile',
        external_id: '1234567890123456789',
        data: { username: 'handle', metadata: { description } },
      }),
    ],
  },
})
it('shows the saved bio without the synthetic handle prefix', () => {
  expect(present(xProfile('Actual bio with @handle')).body).toBe(
    'Actual bio with @handle',
  )
  // No bio shows no bio, not a placeholder.
  expect(present(xProfile('')).body).toBe('')
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
    entity({
      key: 'friend',
      type: 'x.profile',
      data: { username: 'Friend' },
      saved_collection_id: 'friend-id',
    }),
    entity({
      key: 'unknown',
      type: 'x.profile',
      data: { username: 'unknown' },
    }),
  )
  expect(
    mentionParts(collection, 'Hello @FRIEND! @unknown mail@friend.test'),
  ).toEqual([
    { text: 'Hello ' },
    { text: '@FRIEND', href: '#/collection/friend-id' },
    { text: '! @unknown mail@friend.test' },
  ])
})
it('reads the author as last seen, or as captured on request', () => {
  const a = xPost({}, { protected: false })
  const author = a.graph!.entities[1]!
  author.data.name = 'Old name'
  author.current = {
    id: 'v2',
    data: {
      name: 'New name',
      username: 'renamed',
      metadata: { protected: true },
    },
  }
  // A capture made while the account was public still shows its current lock.
  const latest = present({ ...a, author_name: 'Old name' })
  expect([latest.name, latest.handle, latest.locked]).toEqual([
    'New name',
    'renamed',
    true,
  ])
  expect(latest.profileChanged).toBe(true)
  const captured = present(a, { captured: true })
  expect([captured.name, captured.handle, captured.locked]).toEqual([
    'Old name',
    'handle',
    false,
  ])
})
it('offers the captured profile only when it would look different', () => {
  const avatar = (id: string, sha256?: string, sensitive = false) =>
    asset({
      id,
      url: `/v1/assets/${id}?inline=1`,
      purpose: 'avatar',
      sha256,
      sensitive,
    })
  const changed = (
    captured: Partial<Entity>,
    current: NonNullable<Entity['current']>,
  ) => {
    const a = xPost({}, { protected: false, followers: 1 })
    Object.assign(a.graph!.entities[1]!, captured, { current })
    return present(a).profileChanged
  }
  const data = { username: 'handle', metadata: { protected: false } }
  // Counts and other unseen fields changed, nothing a reader sees.
  expect(
    changed(
      {},
      {
        id: 'v2',
        data: { ...data, metadata: { protected: false, followers: 9 } },
      },
    ),
  ).toBe(false)
  expect(changed({}, { id: 'v2', data: { ...data, name: 'New' } })).toBe(true)
  expect(
    changed({}, { id: 'v2', data: { ...data, username: 'renamed' } }),
  ).toBe(true)
  expect(
    changed({}, { id: 'v2', data: { ...data, metadata: { protected: true } } }),
  ).toBe(true)
  // The same image saved twice is the same avatar.
  expect(
    changed(
      { assets: [avatar('a1', 'same')] },
      { id: 'v2', data, assets: [avatar('a2', 'same')] },
    ),
  ).toBe(false)
  expect(
    changed(
      { assets: [avatar('a1', 'old')] },
      { id: 'v2', data, assets: [avatar('a2', 'new')] },
    ),
  ).toBe(true)
  expect(
    changed(
      { assets: [avatar('a1')] },
      { id: 'v2', data, assets: [avatar('a2')] },
    ),
  ).toBe(true)
  // A newer version without an avatar keeps the captured one.
  expect(changed({ assets: [avatar('a1', 'old')] }, { id: 'v2', data })).toBe(
    false,
  )
  // A sensitive avatar is never shown in a header.
  expect(
    changed({}, { id: 'v2', data, assets: [avatar('a2', 'new', true)] }),
  ).toBe(false)
})
it('offers the captured profile for related authors that look different', () => {
  const author = entity({
    key: 'quote-author',
    type: 'x.profile',
    data: { name: 'Old' },
    current: { id: 'v2', data: { name: 'New' } },
  })
  const a = xPost({}, {})
  a.graph!.entities.push(entity({ key: 'quote', type: 'x.post' }), author)
  a.graph!.relations.push(
    { source: 'p', target: 'quote', type: 'quoted' },
    { source: 'quote', target: 'quote-author', type: 'authored_by' },
  )
  expect(present(a).profileChanged).toBe(true)
  const incoming = xPost({}, {})
  incoming.incoming_relations = [
    {
      type: 'quoted',
      entity: entity({ key: 'source', type: 'x.post' }),
      author,
    },
  ]
  expect(present(incoming).profileChanged).toBe(true)
  // Nothing on an account's own page reads as another version.
  const profile = xProfile()
  profile.graph!.entities.push(author)
  expect(present(profile).profileChanged).toBe(false)
})
it('locks by the profile', () => {
  expect(present(xPost({}, { protected: true })).locked).toBe(true)
  expect(present(xPost({}, { protected: false })).locked).toBe(false)
  expect(present(xPost({}, {})).locked).toBe(false)
})
it('notes a source found gone', () => {
  const a = xPost({}, {})
  expect(sourceStateNotice(a)).toBe('')
  expect(sourceStateNotice({ ...a, source_state: 'deleted' })).toBe(
    '原帖已删除',
  )
  expect(
    sourceStateNotice({ ...a, source_state: 'suspended' }).startsWith(
      '作者已被封禁',
    ),
  ).toBe(true)
})
