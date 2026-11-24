import { Buffer } from 'node:buffer'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, onTestFinished, test } from 'vitest'
import { addAccount, type AccountsContext } from '#accounts/accounts.ts'
import {
  assets,
  captures,
  catalog,
  collections,
  entities,
  followEdges,
  jobs,
  library,
  relationFetches,
  revisions,
} from '#db/schema.ts'
import { listProfileChanges } from '#library/changes.ts'
import { followGraph } from '#library/follow-graph.ts'
import { followCounts, listFollowChanges } from '#library/follows.ts'
import { listCollections } from '#library/list.ts'
import { getCollection } from '#library/read.ts'
import { REMOTE_IMAGES } from '#library/views.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  fakeProfile,
  type FakeRelations,
} from '#testing/fake-platform.ts'
import { JPEG } from '#testing/library.ts'
import { captureHandlers } from './handlers.ts'
import { captureURL, recapture, recordDetail } from './records.ts'
import { LISTED_MEDIA } from './relation-store.ts'
import type { RelationList, RelationsRequest } from '#platforms/platform.ts'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** Let the fake platform stand in for X, whose image addresses last. */
function useRemoteImages(): void {
  REMOTE_IMAGES.add('fake')
  onTestFinished(() => {
    REMOTE_IMAGES.delete('fake')
  })
}

/** What the fake source says now: profiles' counts, and the lists. */
interface World {
  counts: Record<string, { following: number; followers: number }>
  lists: Record<string, Partial<Record<RelationList, string[]>>>
  /** Accounts per page. */
  pageSize: number
  /** Follower counts the lists give for their accounts. */
  listed?: Record<string, number>
  /** Profiles fetched for real come with an avatar to download. */
  avatars?: boolean
  /**
   * How far each reading of the clock moves it; downloads snooze for a
   * second, so with a step that long they would never let timers run.
   */
  step?: number
  /**
   * Accounts whose profiles say they are not protected, so their lists are
   * read without an account; the others' profiles say nothing.
   */
  public?: string[]
  /** Make the request for a page fail. */
  fail?: (req: RelationsRequest) => Error | undefined
  requests: RelationsRequest[]
}

const SUBJECT = 'https://fake.test/u/100'

function setup(world: Partial<World> = {}) {
  const state: World = {
    counts: {},
    lists: {},
    pageSize: 2,
    requests: [],
    ...world,
  }
  const relations: FakeRelations = (req) => {
    state.requests.push(req)
    const error = state.fail?.(req)
    if (error) throw error
    const all = state.lists[req.externalId]?.[req.list] ?? []
    const start = req.cursor ? Number(req.cursor) : 0
    const page = all.slice(start, start + state.pageSize)
    const next = start + state.pageSize
    return {
      accounts: page.map((id) =>
        fakeProfile(
          id,
          {
            name: `Name ${id}`,
            ...(state.listed?.[id] !== undefined && {
              counts: { followers: state.listed[id], following: 0 },
            }),
          },
          { avatar: `https://m.test/${id}.jpg` },
        ),
      ),
      nextCursor: next < all.length ? String(next) : '',
    }
  }
  let clock = Date.parse('2026-01-01T00:00:00Z')
  ctx = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            const id = req.externalId
            const counts = state.counts[id] ?? { following: 0, followers: 0 }
            // The same account as its list entries describe it.
            return {
              ...fakeProfile(
                id,
                {
                  name: `Name ${id}`,
                  counts,
                  ...(state.public?.includes(id) && { protected: false }),
                },
                state.avatars
                  ? { avatar: `https://m.test/real-${id}.jpg` }
                  : {},
              ),
              providerId: req.providerId,
            }
          },
        },
        { current: relations },
      ),
    ],
    handlers: captureHandlers,
    fetch: async () => new Response(JPEG),
    // Every reading of the clock moves it on, so each fetch is later.
    now: () => (clock += state.step ?? 1000),
  })
  ctx.queue.start()
  return { ctx, state }
}

/** Run jobs, letting the clock pass retry delays, until none is left. */
async function settleJobs(c: AccountsContext) {
  for (let i = 0; i < 500; i++) {
    await c.queue.drain()
    if (!c.db.select().from(jobs).get()) return
  }
  throw new Error('jobs never settled')
}

async function withAccount(c: AccountsContext) {
  await addAccount(c, 'fake', { credential: Buffer.from('owner') })
}

/** Capture the subject profile with its lists and wait for all of it. */
async function update(c: AccountsContext, url = SUBJECT) {
  const job = captureURL(c, url, undefined, undefined, true)
  await c.queue.drain()
  return job
}

const fetchesOf = (c: AccountsContext, list: RelationList) =>
  c.db
    .select()
    .from(relationFetches)
    .where(eq(relationFetches.list, list))
    .orderBy(relationFetches.createdAt)
    .all()

function entityId(c: AccountsContext, externalId: string) {
  return c.db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.kind, 'fake.profile'),
        eq(entities.externalId, externalId),
      ),
    )
    .get()?.id
}

/** Open follows as `follower>followee` external ids, sorted. */
function openEdges(c: AccountsContext) {
  const ids = new Map(
    c.db
      .select({ id: entities.id, externalId: entities.externalId })
      .from(entities)
      .all()
      .map((row) => [row.id, row.externalId]),
  )
  return c.db
    .select()
    .from(followEdges)
    .where(isNull(followEdges.endedAt))
    .all()
    .map((e) => `${ids.get(e.followerId)}>${ids.get(e.followeeId)}`)
    .toSorted()
}

const subjectCollection = (c: AccountsContext) =>
  c.db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.externalId, '100'))
    .get()!.id

describe('抓关系网', () => {
  test('pages through both lists, saving every listed account as a profile', async () => {
    const following = [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
    ]
    const { ctx, state } = setup({
      counts: { '100': { following: 13, followers: 2 } },
      lists: { '100': { following, followers: ['21', '22'] } },
    })
    await withAccount(ctx)
    const job = await update(ctx)

    // 13 accounts, two per page: seven pages, over more than one run.
    const pages = state.requests.filter((r) => r.list === 'following')
    expect(pages.map((r) => r.cursor)).toEqual([
      '',
      '2',
      '4',
      '6',
      '8',
      '10',
      '12',
    ])
    expect(fetchesOf(ctx, 'following')[0]).toMatchObject({
      state: 'complete',
      expected: 13,
      fetched: 13,
      pages: 7,
    })
    expect(fetchesOf(ctx, 'followers')[0]).toMatchObject({
      state: 'complete',
      fetched: 2,
    })
    expect(openEdges(ctx)).toEqual(
      [...following.map((id) => `100>${id}`), '21>100', '22>100'].toSorted(),
    )

    // Each listed account is a saved profile with a version from the list,
    // its images recorded as not downloaded rather than missing.
    const saved = ctx.db
      .select({ externalId: collections.externalId })
      .from(library)
      .innerJoin(collections, eq(collections.id, library.collectionId))
      .all()
    expect(saved).toHaveLength(16)
    const listed = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, '21'))
      .get()!
    const revision = ctx.db
      .select()
      .from(revisions)
      .where(eq(revisions.collectionId, listed.id))
      .get()!
    expect(listed.currentRevision).toBe(revision.id)
    expect(revision.payload).toMatchObject({
      text: 'Name 21',
      incomplete: true,
    })
    expect(
      ctx.db
        .select({ state: assets.state, error: assets.error })
        .from(assets)
        .innerJoin(captures, eq(captures.id, assets.captureId))
        .where(eq(captures.collectionId, listed.id))
        .all(),
    ).toEqual([{ state: 'failed', error: LISTED_MEDIA }])
    expect(
      ctx.db
        .select({ search: catalog.search })
        .from(catalog)
        .where(eq(catalog.collectionId, listed.id))
        .get()?.search,
    ).toContain('Name 21')

    // The record runs until its lists are done, and tells how they went.
    const record = recordDetail(ctx.db, job.submissionId)
    expect(record.done).toBe(true)
    expect(record.relations).toEqual([
      { list: 'following', state: 'complete', expected: 13, fetched: 13 },
      { list: 'followers', state: 'complete', expected: 2, fetched: 2 },
    ])
    expect(followCounts(ctx, subjectCollection(ctx))).toEqual({
      following: 13,
      followers: 2,
      mutual: 0,
    })
  })

  test("a public account's lists come from the public source, without an account", async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 3, followers: 1 } },
      lists: { '100': { following: ['1', '2', '3'], followers: ['9'] } },
      public: ['100'],
    })
    await update(ctx)
    expect(state.requests).not.toHaveLength(0)
    for (const req of state.requests) {
      expect(req.providerId).toBe('public')
      expect(req.credential).toBeUndefined()
    }
    for (const list of ['following', 'followers'] as const)
      expect(fetchesOf(ctx, list)[0]).toMatchObject({
        state: 'complete',
        providerId: 'public',
        connectionId: null,
      })
    expect(openEdges(ctx)).toEqual(['100>1', '100>2', '100>3', '9>100'])
  })

  test("a protected account's lists are read with the account", async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 1, followers: 0 } },
      lists: { '100': { following: ['1'] } },
    })
    await withAccount(ctx)
    await update(ctx)
    expect(state.requests).toHaveLength(2)
    for (const req of state.requests) {
      expect(req.providerId).toBe('session')
      expect(Buffer.from(req.credential!.data).toString()).toBe('owner')
    }
    expect(fetchesOf(ctx, 'following')[0]).toMatchObject({
      state: 'complete',
      providerId: 'session',
    })
    expect(fetchesOf(ctx, 'following')[0]!.connectionId).toBeTruthy()
  })

  test('a transient failure is retried; once retries run out the list fails with the reason', async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 4, followers: 0 } },
      lists: { '100': { following: ['1', '2', '3', '4'] } },
      public: ['100'],
    })
    let failures = 1
    state.fail = (req) =>
      req.cursor === '2' && failures-- > 0
        ? new FakeFailure(status.UNAVAILABLE, 'FxTwitter 公共接口返回 HTTP 500')
        : undefined
    await update(ctx)
    await settleJobs(ctx)
    expect(fetchesOf(ctx, 'following')[0]).toMatchObject({
      state: 'complete',
      fetched: 4,
    })
    const following = () =>
      state.requests.filter((r) => r.list === 'following').map((r) => r.cursor)
    expect(following()).toEqual(['', '2', '2'])

    state.requests = []
    state.fail = (req) =>
      req.cursor === '2'
        ? new FakeFailure(status.UNAVAILABLE, 'FxTwitter 公共接口返回 HTTP 500')
        : undefined
    await update(ctx)
    await settleJobs(ctx)
    expect(fetchesOf(ctx, 'following')[1]).toMatchObject({
      state: 'failed',
      error: 'FxTwitter 公共接口返回 HTTP 500',
    })
    // Five attempts at the failing page, after the first page went through.
    expect(following()).toEqual(['', '2', '2', '2', '2', '2'])
    // What the failed fetch saw is kept, and nothing ended.
    expect(openEdges(ctx)).toEqual(['100>1', '100>2', '100>3', '100>4'])
  })

  test('when every way to ask is rate-limited, the wait uses no attempt', async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 1, followers: 0 } },
      lists: { '100': { following: ['1'] } },
    })
    await withAccount(ctx)
    state.fail = () =>
      new FakeFailure(status.UNAVAILABLE, '关注列表的两个 X 接口均已限流', {
        'retry-after': '600',
        'rate-limited': '1',
      })
    await update(ctx)
    const fetch = fetchesOf(ctx, 'following')[0]!
    expect(fetch.state).toBe('running')
    const row = ctx.db.select().from(jobs).where(eq(jobs.ref, fetch.id)).get()!
    expect(row.attempt).toBe(0)
    expect(row.runAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(
      500_000,
    )
  })

  test('a list over 5000 is skipped, the other still fetched', async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 3, followers: 20_000 } },
      lists: { '100': { following: ['1', '2', '3'], followers: ['9'] } },
    })
    await withAccount(ctx)
    await update(ctx)
    expect(state.requests.every((r) => r.list === 'following')).toBe(true)
    expect(fetchesOf(ctx, 'followers')[0]).toMatchObject({
      state: 'skipped',
      expected: 20_000,
      error: '超过 5000 人，未抓取',
    })
    expect(fetchesOf(ctx, 'following')[0]?.state).toBe('complete')
  })

  test('without an account the profile is saved and the lists fail', async () => {
    const { ctx } = setup({ counts: { '100': { following: 1, followers: 1 } } })
    await update(ctx)
    expect(fetchesOf(ctx, 'following').map((f) => [f.state, f.error])).toEqual([
      ['failed', '抓关系网需要可用的采集账号'],
    ])
    expect(ctx.db.select().from(revisions).all()).toHaveLength(1)
  })

  test('only a complete fetch ends follows, a partial or failed one never does', async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 3, followers: 0 } },
      lists: { '100': { following: ['1', '2', '3'] } },
    })
    await withAccount(ctx)
    await update(ctx)
    expect(openEdges(ctx)).toEqual(['100>1', '100>2', '100>3'])

    // A listing that stops short of the count: partial, nothing ends.
    state.counts['100']!.following = 30
    state.lists['100']!.following = ['1']
    await update(ctx)
    expect(fetchesOf(ctx, 'following')[1]).toMatchObject({
      state: 'partial',
      fetched: 1,
    })
    expect(openEdges(ctx)).toEqual(['100>1', '100>2', '100>3'])

    // A listing that fails half way: failed, nothing ends either.
    state.counts['100']!.following = 2
    state.lists['100']!.following = ['1', '4', '5']
    state.fail = (req) =>
      req.cursor === '2'
        ? new FakeFailure(status.FAILED_PRECONDITION, '列表不可用')
        : undefined
    await update(ctx)
    expect(fetchesOf(ctx, 'following')[2]).toMatchObject({
      state: 'failed',
      error: '列表不可用',
    })
    // What it did see is kept.
    expect(openEdges(ctx)).toEqual(['100>1', '100>2', '100>3', '100>4'])

    // A complete listing ends the follows it lacks.
    state.fail = undefined
    state.lists['100']!.following = ['1', '4']
    await update(ctx)
    expect(openEdges(ctx)).toEqual(['100>1', '100>4'])
    const ended = ctx.db
      .select()
      .from(followEdges)
      .where(eq(followEdges.followerId, entityId(ctx, '100')!))
      .all()
      .filter((e) => e.endedAt)
    expect(ended).toHaveLength(2)
  })

  test("a complete followers list ends others' follows of the account", async () => {
    const { ctx, state } = setup({
      counts: {
        '100': { following: 0, followers: 2 },
        '7': { following: 1, followers: 0 },
      },
      lists: { '100': { followers: ['7', '8'] }, '7': { following: ['100'] } },
    })
    await withAccount(ctx)
    await update(ctx)
    expect(openEdges(ctx)).toEqual(['7>100', '8>100'])
    // 7's own list says the same follow: still one edge.
    await update(ctx, 'https://fake.test/u/7')
    expect(openEdges(ctx)).toEqual(['7>100', '8>100'])
    state.counts['100']!.followers = 1
    state.lists['100']!.followers = ['8']
    await update(ctx)
    expect(openEdges(ctx)).toEqual(['8>100'])
  })

  test('a profile fetched for real keeps its versions when listed', async () => {
    const { ctx } = setup({
      counts: { '100': { following: 1, followers: 0 } },
      lists: { '100': { following: ['200'] } },
    })
    await withAccount(ctx)
    captureURL(ctx, 'https://fake.test/u/200')
    await ctx.queue.drain()
    const real = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, '200'))
      .get()!
    await update(ctx)
    expect(
      ctx.db
        .select({ id: revisions.id })
        .from(revisions)
        .where(eq(revisions.collectionId, real.id))
        .all(),
    ).toEqual([{ id: real.currentRevision }])
    expect(listProfileChanges(ctx, real.id).items).toEqual([])
    expect(openEdges(ctx)).toEqual(['100>200'])
  })

  test('a profile first saved from a list shows no made-up changes once fetched for real', async () => {
    const { ctx } = setup({
      counts: { '100': { following: 1, followers: 0 } },
      lists: { '100': { following: ['300'] } },
    })
    await withAccount(ctx)
    await update(ctx)
    captureURL(ctx, 'https://fake.test/u/300')
    await ctx.queue.drain()
    const listed = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, '300'))
      .get()!
    expect(
      ctx.db
        .select()
        .from(revisions)
        .where(eq(revisions.collectionId, listed.id))
        .all(),
    ).toHaveLength(2)
    // The list's images were never known, so they changed nothing.
    expect(listProfileChanges(ctx, listed.id).items).toEqual([])
  })

  test('a listed account shows its avatar from the platform until one is saved', async () => {
    const { ctx, state } = setup({
      counts: { '100': { following: 1, followers: 0 } },
      lists: { '100': { following: ['300'] } },
      step: 1,
    })
    await withAccount(ctx)
    await update(ctx)
    const listed = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, '300'))
      .get()!
    const avatarOf = (view: ReturnType<typeof getCollection>) =>
      view.graph?.entities
        .find((e) => e.key === view.graph?.root)
        ?.assets?.find((a) => a.purpose === 'avatar')
    const item = () =>
      listCollections(ctx, { entityType: 'fake.profile' }).items.find(
        (i) => i.id === listed.id,
      )!
    // Like Instagram, whose image addresses expire: nothing to show.
    for (const view of [getCollection(ctx, listed.id), item()])
      expect(avatarOf(view)).not.toHaveProperty('remote_url')

    // Like X: not downloaded, so no signed link, only the platform's address.
    useRemoteImages()
    const remote = avatarOf(getCollection(ctx, listed.id))
    expect(remote).toMatchObject({
      state: 'failed',
      remote_url: 'https://m.test/300.jpg',
    })
    expect(remote).not.toHaveProperty('url')
    expect(avatarOf(item())?.remote_url).toBe('https://m.test/300.jpg')

    // Once fetched for real, the saved copy is shown instead.
    state.avatars = true
    captureURL(ctx, 'https://fake.test/u/300')
    await ctx.queue.drain()
    const saved = avatarOf(getCollection(ctx, listed.id))
    expect(saved).toMatchObject({ state: 'ready' })
    expect(saved?.url).toBeDefined()
    expect(saved).not.toHaveProperty('remote_url')
    // The list's image was never known, so the saved one changed nothing.
    expect(listProfileChanges(ctx, listed.id).items).toEqual([])
  })

  test('follow changes: news and ends after the first complete fetch, newest first', async () => {
    useRemoteImages()
    const { ctx, state } = setup({
      counts: { '100': { following: 2, followers: 2 } },
      lists: {
        '100': { following: ['1', '2'], followers: ['2', '3'] },
      },
    })
    await withAccount(ctx)
    await update(ctx)
    const id = subjectCollection(ctx)
    // The first complete fetch is where the record starts: no changes yet.
    expect(listFollowChanges(ctx, id).items).toEqual([])
    expect(followCounts(ctx, id)).toEqual({
      following: 2,
      followers: 2,
      mutual: 1,
    })

    state.lists['100'] = { following: ['2', '4'], followers: ['3', '5'] }
    await update(ctx)
    const first = fetchesOf(ctx, 'following')[0]!.finishedAt!.toISOString()
    const changes = listFollowChanges(ctx, id).items
    expect(
      changes.map((c) => [c.type, c.account.external_id]).toSorted(),
    ).toEqual(
      [
        ['follow', '4'],
        ['unfollow', '1'],
        ['followed_by', '5'],
        ['unfollowed_by', '2'],
      ].toSorted(),
    )
    for (const change of changes) {
      expect(change.since! <= change.observed_at).toBe(true)
      expect(change.account).toMatchObject({
        name: `Name ${change.account.external_id}`,
        // Known only from the lists: shown from the platform.
        avatar: {
          remote_url: `https://m.test/${change.account.external_id}.jpg`,
        },
      })
      expect(change.account.collection_id).toBeDefined()
    }
    // A new one happened after the last complete fetch that lacked it.
    expect(changes.find((c) => c.type === 'follow')?.since).toBe(first)
    // Newest first.
    const times = changes.map((c) => c.observed_at)
    expect(times).toEqual(times.toSorted().toReversed())
    expect(listFollowChanges(ctx, id, 1)).toMatchObject({
      items: [changes[0]],
      truncated: true,
    })
    expect(followCounts(ctx, id).mutual).toBe(0)
  })

  test('a profile never listed has no counts or changes, and a retry asks again', async () => {
    const { ctx } = setup({ counts: { '100': { following: 0, followers: 0 } } })
    captureURL(ctx, SUBJECT)
    await ctx.queue.drain()
    const id = subjectCollection(ctx)
    expect(followCounts(ctx, id)).toEqual({})
    expect(listFollowChanges(ctx, id).items).toEqual([])
    await withAccount(ctx)
    recapture(ctx, id, { relations: true })
    await ctx.queue.drain()
    expect(fetchesOf(ctx, 'following')[0]?.state).toBe('complete')
  })
})

describe('关系图谱', () => {
  /**
   * 100 follows 1, 2 and 3; 2 and 4 follow it. 1 follows 2, which only 1's
   * own list tells.
   */
  async function world() {
    const { ctx, state } = setup({
      counts: {
        '100': { following: 3, followers: 2 },
        '1': { following: 1, followers: 1 },
      },
      lists: {
        '100': { following: ['1', '2', '3'], followers: ['2', '4'] },
        '1': { following: ['2'], followers: ['100'] },
      },
      listed: { '1': 1, '2': 50, '3': 10, '4': 30 },
    })
    await withAccount(ctx)
    await update(ctx)
    await update(ctx, 'https://fake.test/u/1')
    return { ctx, state, id: subjectCollection(ctx) }
  }
  const names = (graph: ReturnType<typeof followGraph>) =>
    graph.nodes.map((n) => n.external_id)
  const pairs = (graph: ReturnType<typeof followGraph>) =>
    graph.edges.map(
      ([a, b]) =>
        `${graph.nodes[a]!.external_id}>${graph.nodes[b]!.external_id}`,
    )

  test('the center, then accounts by follower count, with follows among them', async () => {
    useRemoteImages()
    const { ctx, id } = await world()
    const graph = followGraph(ctx, id)
    expect(names(graph)).toEqual(['100', '2', '4', '3', '1'])
    expect(graph.nodes.map((n) => [n.kind, n.followers])).toEqual([
      [undefined, 2],
      ['mutual', 50],
      ['followers', 30],
      ['following', 10],
      ['following', 1],
    ])
    expect(graph.nodes[1]).toMatchObject({
      name: 'Name 2',
      collection_id: expect.any(String),
      avatar: { remote_url: 'https://m.test/2.jpg' },
    })
    expect(graph.nodes[0]).toMatchObject({ collection_id: id, following: 3 })
    // 1>2 is between two others, seen only in 1's own list.
    expect(pairs(graph).toSorted()).toEqual(
      ['100>1', '100>2', '100>3', '2>100', '4>100', '1>2'].toSorted(),
    )
    expect(graph.total).toBe(4)
    expect(graph.kinds).toEqual({ following: 2, followers: 1, mutual: 1 })
    expect(graph.lists.following.complete_at).toBeDefined()
    expect(graph.lists.followers.complete_at).toBeDefined()
    expect(graph.lists.following.partial_at).toBeUndefined()
  })

  test('kinds and the cap choose the accounts, edges follow them', async () => {
    const { ctx, id } = await world()
    const top = followGraph(ctx, id, { limit: 2 })
    expect(names(top)).toEqual(['100', '2', '4'])
    expect(top.total).toBe(4)
    expect(pairs(top).toSorted()).toEqual(['100>2', '2>100', '4>100'])

    const following = followGraph(ctx, id, { kinds: ['following'] })
    expect(names(following)).toEqual(['100', '3', '1'])
    expect(following.total).toBe(2)
    // 1 follows 2, but 2 is not shown.
    expect(pairs(following).toSorted()).toEqual(['100>1', '100>3'])
    // Counts by kind do not depend on the choice.
    expect(following.kinds).toEqual({ following: 2, followers: 1, mutual: 1 })
    expect(names(followGraph(ctx, id, { kinds: [] }))).toEqual(['100'])
  })

  test('follows among the others come from any account’s list, not only the center’s', async () => {
    const { ctx, state, id } = await world()
    // 4 follows 3: only 3's own followers list tells.
    state.counts['3'] = { following: 0, followers: 2 }
    state.lists['3'] = { following: [], followers: ['100', '4'] }
    await update(ctx, 'https://fake.test/u/3')
    expect(pairs(followGraph(ctx, id)).toSorted()).toEqual(
      ['100>1', '100>2', '100>3', '2>100', '4>100', '1>2', '4>3'].toSorted(),
    )
  })

  test('ended follows are left out', async () => {
    const { ctx, state, id } = await world()
    state.counts['100'] = { following: 2, followers: 1 }
    state.lists['100'] = { following: ['2', '3'], followers: ['2'] }
    await update(ctx)
    const graph = followGraph(ctx, id)
    expect(names(graph)).toEqual(['100', '2', '3'])
    // 1 still follows 2, but 1 is gone from the graph with its edge.
    expect(pairs(graph).toSorted()).toEqual(['100>2', '100>3', '2>100'])
    expect(graph.kinds).toEqual({ following: 1, followers: 0, mutual: 1 })
  })

  test('a partial list fetch is told apart, and a profile without follows is alone', async () => {
    const { ctx } = setup({
      counts: { '100': { following: 40, followers: 0 } },
      lists: { '100': { following: ['1'], followers: [] } },
    })
    await withAccount(ctx)
    await update(ctx)
    const id = subjectCollection(ctx)
    const graph = followGraph(ctx, id)
    expect(graph.lists.following).toEqual({ partial_at: expect.any(String) })
    expect(graph.lists.followers.complete_at).toBeDefined()
    expect(names(graph)).toEqual(['100', '1'])

    captureURL(ctx, 'https://fake.test/u/7')
    await ctx.queue.drain()
    const alone = ctx.db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.externalId, '7'))
      .get()!.id
    expect(followGraph(ctx, alone)).toMatchObject({
      nodes: [{ external_id: '7', collection_id: alone }],
      edges: [],
      total: 0,
      lists: { following: {}, followers: {} },
    })
  })
})
