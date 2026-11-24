import { afterEach, expect, test } from 'vitest'
import {
  capture,
  entity,
  graph,
  image,
  libraryContext,
} from '#testing/library.ts'
import { listProfileChanges } from './changes.ts'
import { deleteCollection } from './delete.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** What the fake profile 100 answers with; tests change it between captures. */
interface Profile {
  name: string
  username: string
  description?: string
  protected?: boolean
  /** Paths of the images; under /missing/ they fail to download. */
  avatar?: string
  avatarUrl?: string
  banner?: string
  extra?: Record<string, unknown>
  text?: string
  reposts?: boolean
}

function setup(state: Profile) {
  const made = libraryContext((req): Partial<FetchResponse> => {
    if (req.externalId === '1') return { text: 'post' }
    const resources = [
      ...(state.avatar ? [image(state.avatar, { purpose: 'avatar' })] : []),
      ...(state.banner ? [image(state.banner, { purpose: 'banner' })] : []),
    ]
    return {
      text: state.text ?? `@${state.username}\n${state.description ?? ''}`,
      resources,
      graph: graph(
        [
          entity(
            'root',
            'fake.profile',
            '100',
            {
              name: state.name,
              username: state.username,
              ...(state.avatarUrl ? { avatar_url: state.avatarUrl } : {}),
              metadata: {
                ...(state.description === undefined
                  ? {}
                  : { description: state.description }),
                ...(state.protected === undefined
                  ? {}
                  : { protected: state.protected }),
                ...state.extra,
              },
            },
            resources.map((_, i) => i),
          ),
          ...(state.reposts ? [entity('r1', 'fake.post', 'T1')] : []),
        ],
        ...(state.reposts
          ? ([['root', 'reposted', 'r1']] as [string, string, string][])
          : []),
      ),
    }
  })
  ctx = made.ctx
  return made.ctx
}

const profile = 'https://fake.test/u/100'

test('each shown field that changed, at the capture that first saw it', async () => {
  const state: Profile = {
    name: 'A',
    username: 'a',
    description: 'bio',
    protected: false,
    avatar: 'avatar-1.jpg',
    banner: 'banner-1.jpg',
  }
  const ctx = setup(state)
  const first = await capture(ctx, profile)
  const id = first.collectionId
  const refresh = () => capture(ctx, { refreshId: id })
  state.name = 'B'
  const renamed = await refresh()
  // The same look again adds no entry of its own.
  await refresh()
  state.username = 'b'
  state.description = ' new bio '
  const moved = await refresh()
  state.protected = true
  const locked = await refresh()
  state.avatar = 'avatar-2.jpg'
  state.banner = undefined
  const pictured = await refresh()
  state.description = ''
  state.protected = false
  state.banner = 'banner-2.jpg'
  const last = await refresh()

  const assets = (id: string) => ({
    id: expect.any(String),
    url: expect.stringContaining('/media/'),
    sha256: expect.any(String),
    purpose: id,
  })
  const at = (c: typeof first) => ({
    capture_id: c.id,
    revision_id: c.revisionId,
    observed_at: c.finishedAt!.toISOString(),
  })
  const changes = listProfileChanges(ctx, id)
  expect(changes).toMatchObject({
    items: [
      {
        ...at(last),
        fields: [
          { field: 'bio', before: 'new bio' },
          { field: 'protected', before: true, after: false },
          { field: 'banner', after: assets('banner') },
        ],
      },
      {
        ...at(pictured),
        fields: [
          {
            field: 'avatar',
            before: assets('avatar'),
            after: assets('avatar'),
          },
          { field: 'banner', before: assets('banner') },
        ],
      },
      {
        ...at(locked),
        fields: [{ field: 'protected', before: false, after: true }],
      },
      {
        ...at(moved),
        fields: [
          { field: 'username', before: 'a', after: 'b' },
          { field: 'bio', before: 'bio', after: 'new bio' },
        ],
      },
      { ...at(renamed), fields: [{ field: 'name', before: 'A', after: 'B' }] },
    ],
  })
  expect(changes.truncated).toBeUndefined()
  const [, avatar] = changes.items
  const field = avatar!.fields[0]!
  if (field.field !== 'avatar') throw new Error('expected the avatar')
  expect(field.before!.sha256).not.toBe(field.after!.sha256)
  // A removed image has no after, an added one no before.
  expect(changes.items[0]!.fields[2]).not.toHaveProperty('before')
  expect(changes.items[1]!.fields[1]).not.toHaveProperty('after')
  // The newest first, as many as asked for.
  expect(
    listProfileChanges(ctx, id, 2).items.map((item) => item.capture_id),
  ).toEqual([last.id, pictured.id])
  // Only the newest revisions are compared, the oldest of them against the
  // one before it; earlier changes are left out, and the answer says so.
  const recent = listProfileChanges(ctx, id, undefined, 2)
  expect(recent.items.map((item) => item.capture_id)).toEqual([
    last.id,
    pictured.id,
  ])
  expect(recent.truncated).toBe(true)
  expect(listProfileChanges(ctx, id, undefined, 5).truncated).toBeUndefined()
})

test('revisions that look the same on the page make no entry', async () => {
  const state: Profile = {
    name: 'A',
    username: 'a',
    description: 'bio',
    protected: false,
    avatar: 'avatar.jpg',
    avatarUrl: 'https://m.test/avatar.jpg',
  }
  const ctx = setup(state)
  const first = await capture(ctx, profile)
  const id = first.collectionId
  const refresh = () => capture(ctx, { refreshId: id })
  // Fields the page does not show: a location, X's volatile ones, counts the
  // fake type keeps in its data, and the timeline's reposts.
  state.extra = {
    location: 'Tokyo',
    raw_description: { facets: [{ type: 'mention' }] },
    about_account: { based_in: 'JP' },
    followers: 5,
  }
  const hidden = await refresh()
  state.reposts = true
  const reposts = await refresh()
  // The avatar uploaded again under a new URL, with the same bytes.
  state.avatarUrl = 'https://m.test/avatar.jpg?v=2'
  const reuploaded = await refresh()
  // Surrounding whitespace is not shown either.
  state.description = 'bio\n'
  const spaced = await refresh()
  // An avatar that failed to save is not known, so it changed nothing; nor
  // does a capture that says nothing of protection.
  state.avatar = 'missing/avatar.jpg'
  state.protected = undefined
  const failed = await refresh()
  state.avatar = 'avatar.jpg'
  state.protected = false
  const back = await refresh()

  const revisions = new Set(
    [first, hidden, reposts, reuploaded, spaced, failed, back].map(
      (c) => c.revisionId,
    ),
  )
  // Each was a revision of its own, and none is an entry.
  expect(revisions.size).toBe(7)
  expect(listProfileChanges(ctx, id)).toEqual({ items: [] })
})

test('a bio without a description reads from the text, as the page does', async () => {
  const state: Profile = { name: 'A', username: 'a', text: '@a\nold' }
  const ctx = setup(state)
  const first = await capture(ctx, profile)
  state.text = '@a\nnew'
  await capture(ctx, { refreshId: first.collectionId })
  expect(listProfileChanges(ctx, first.collectionId).items).toMatchObject([
    { fields: [{ field: 'bio', before: 'old', after: 'new' }] },
  ])
})

test('only saved profiles have changes', async () => {
  const ctx = setup({ name: 'A', username: 'a' })
  const post = await capture(ctx, 'https://fake.test/p/1')
  expect(listProfileChanges(ctx, post.collectionId)).toEqual({ items: [] })
  const done = await capture(ctx, profile)
  deleteCollection(ctx.db, done.collectionId)
  expect(() => listProfileChanges(ctx, done.collectionId)).toThrow(
    '内容不存在或已删除',
  )
  expect(() => listProfileChanges(ctx, 'not-a-uuid')).toThrow(
    '内容不存在或已删除',
  )
})
