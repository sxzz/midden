import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captures,
  collectionIdentityAliases,
  collections,
  collectionTags,
  entities,
  entityVersions,
  identityRequests,
  jobs,
  library,
  submissions,
  tags,
} from '#db/schema.ts'
import { Visibility } from '#platforms/protocol.ts'
import { identifyHandle } from '#platforms/x/identify.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import {
  fetchPublicProfile,
  fetchPublicTimeline,
} from '#platforms/x/profile.ts'
import { publicPost } from '#platforms/x/provider.ts'
import { CaptureStrategy } from '#platforms/x/strategy.ts'
import { testContext } from '#testing/context.ts'
import { captureHandlers } from './handlers.ts'
import {
  FOLD_ATTEMPTS,
  FOLD_BATCH,
  FOLD_SPACING_MS,
  settleHandleProfiles,
} from './identify.ts'
import { recordDetail, retryRecord } from './records.ts'
import { submit } from './submit.ts'
import { listRecords } from './updates.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const VUEUSE = '1375391728614604800'
const HOUR = 60 * 60_000

const user = (id: string, screenName: string) => ({
  code: 200,
  user: {
    type: 'profile',
    id,
    name: screenName,
    screen_name: screenName,
    protected: false,
    description: '',
  },
})
const notFound = { code: 404, message: 'User not found' }

/**
 * The X platform over a fake FxTwitter: `answer` gets each profile request's
 * path (`/VueUse`, `/id:1`); timelines are empty. `session` stands for X's
 * own answer with the account, which none is selected for by default.
 */
function setup(
  answer: (path: string) => unknown,
  session?: (handle: string) => unknown,
  post?: Record<string, unknown>,
) {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const asked: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname.replace('/2/profile', ''))
    if (path.endsWith('/statuses'))
      return Response.json({ code: 200, results: [], cursor: {} })
    asked.push(path)
    const body = answer(path) as { code: number }
    return Response.json(body, { status: body.code })
  }) as typeof fetch
  const strategy = new CaptureStrategy(
    async (id) =>
      publicPost({ ...post, id }, id, {
        body: Buffer.from('{}'),
        contentType: 'application/json',
        sourceUrl: `https://api.fxtwitter.com/2/status/${id}`,
        visibility: Visibility.VISIBILITY_PUBLIC,
      }),
    (id, expand, signal) =>
      fetchPublicProfile(id, expand, signal, undefined, fetcher),
    undefined,
    undefined,
    () => clock,
  )
  strategy.timeline = (result, signal, _fetcher, cursor, size, since) =>
    fetchPublicTimeline(result, signal, fetcher, cursor, size, since)
  const c = testContext({
    platforms: [
      createXPlatform(strategy, undefined, undefined, (handle, signal) =>
        identifyHandle(
          handle,
          signal,
          () =>
            session
              ? { authToken: 'a'.repeat(40), csrfToken: 'b'.repeat(64) }
              : undefined,
          {
            fetcher,
            session: async (h) => {
              asked.push(`session:${h}`)
              const data = session!(h) as any
              if (data instanceof Error) throw data
              return data?.code === 200
                ? { id: data.user.id }
                : data?.code === 404 && !data.reason
                  ? 'none'
                  : 'miss'
            },
          },
        ),
      ),
    ],
    handlers: captureHandlers,
    now: () => clock,
  })
  ctx = c
  c.queue.start()
  return { ctx: c, asked, advance: (ms: number) => (clock += ms) }
}

/** An account the library knows from a list: an entity, no collection. */
function listed(c: CaptureContext, id: string, username: string) {
  c.db
    .insert(entities)
    .values({ id: `e${id}`, platform: 'x', kind: 'x.profile', externalId: id })
    .run()
  c.db
    .insert(entityVersions)
    .values({
      id: `v${id}`,
      entityId: `e${id}`,
      contentHash: `h${id}`,
      data: { username, name: username, avatar_url: '', metadata: {} },
    })
    .run()
}

/** No X collection is ever keyed by a handle. */
const handleKeyed = (c: CaptureContext) =>
  c.db
    .select({ id: collections.id })
    .from(collections)
    .where(
      sql`${collections.platform} = 'x' AND ${collections.externalId} LIKE 'handle:%'`,
    )
    .all()

describe('submitting a profile by its handle', () => {
  test('an account the library knows is saved under its id at once, without asking', async () => {
    const { ctx, asked } = setup((path) =>
      path === `/id:${VUEUSE}` ? user(VUEUSE, 'VueUse') : notFound,
    )
    listed(ctx, VUEUSE, 'VueUse')
    const job = submit(ctx, { url: 'https://x.com/vueuse' })
    expect(job.collectionId).not.toBe('')
    await ctx.queue.drain()
    expect(asked).toEqual([`/id:${VUEUSE}`])
    expect(ctx.db.select().from(collections).all()).toMatchObject([
      { externalId: VUEUSE, url: `https://x.com/i/user/${VUEUSE}` },
    ])
    expect(ctx.db.select().from(identityRequests).all()).toEqual([])
  })

  test('an unknown one is identified first, as written, and becomes its submission under the same id', async () => {
    const { ctx, asked } = setup((path) =>
      path === '/VueUse' || path === `/id:${VUEUSE}`
        ? user(VUEUSE, 'VueUse')
        : notFound,
    )
    const job = submit(ctx, { url: 'https://x.com/VueUse', key: 'k' })
    // A record of its own until identified: nothing saved yet.
    expect(job).toMatchObject({ collectionId: '', state: 'queued' })
    expect(ctx.db.select().from(collections).all()).toEqual([])
    expect(listRecords(ctx.db).items).toMatchObject([
      { id: job.submissionId, state: 'queued', url: 'https://x.com/VueUse' },
    ])
    await ctx.queue.drain()
    expect(asked).toEqual(['/VueUse', `/id:${VUEUSE}`])
    const made = ctx.db.select().from(submissions).get()!
    expect(made.id).toBe(job.submissionId)
    expect(recordDetail(ctx.db, job.submissionId)).toMatchObject({
      state: 'complete',
      url: `https://x.com/i/user/${VUEUSE}`,
      input: 'https://x.com/VueUse',
    })
    expect(ctx.db.select().from(collectionIdentityAliases).all()).toMatchObject(
      [{ externalId: 'handle:vueuse' }],
    )
    // The same request again is that submission; the handle is known now.
    expect(submit(ctx, { url: 'https://x.com/VueUse', key: 'k' }).id).toBe(
      made.captureId,
    )
    expect(submit(ctx, { url: 'https://x.com/vueuse' }).collectionId).not.toBe(
      '',
    )
    expect(handleKeyed(ctx)).toEqual([])
  })

  test('the handle in lower case, then X with the account, when FxTwitter fails', async () => {
    const lower = setup((path) =>
      path === '/vueuse' || path === `/id:${VUEUSE}`
        ? user(VUEUSE, 'VueUse')
        : notFound,
    )
    submit(lower.ctx, { url: 'https://x.com/VueUse' })
    await lower.ctx.queue.drain()
    expect(lower.asked).toEqual(['/VueUse', '/vueuse', `/id:${VUEUSE}`])
    await lower.ctx.queue.stop()

    const session = setup(
      (path) => (path === `/id:${VUEUSE}` ? user(VUEUSE, 'VueUse') : notFound),
      () => user(VUEUSE, 'VueUse'),
    )
    submit(session.ctx, { url: 'https://x.com/VueUse' })
    await session.ctx.queue.drain()
    expect(session.asked).toEqual([
      '/VueUse',
      '/vueuse',
      'session:VueUse',
      `/id:${VUEUSE}`,
    ])
    expect(handleKeyed(session.ctx)).toEqual([])
  })

  test('a suspended account is its id: saved, and its capture says it is suspended', async () => {
    const { ctx } = setup((path) =>
      path === '/gone' || path === '/id:42'
        ? {
            code: 404,
            message: 'User is suspended',
            reason: 'suspended',
            id: '42',
          }
        : notFound,
    )
    submit(ctx, { url: 'https://x.com/gone' })
    await ctx.queue.drain()
    expect(ctx.db.select().from(collections).all()).toMatchObject([
      { externalId: '42', sourceState: 'suspended' },
    ])
  })

  test('one no lookup identifies stays a request, retried, then failed with why; no collection', async () => {
    const { ctx, advance } = setup(() => notFound)
    const job = submit(ctx, { url: 'https://x.com/Nobody' })
    for (let i = 0; i < 5; i++) {
      await ctx.queue.drain()
      advance(HOUR)
    }
    await ctx.queue.drain()
    expect(ctx.db.select().from(collections).all()).toEqual([])
    expect(handleKeyed(ctx)).toEqual([])
    expect(recordDetail(ctx.db, job.submissionId)).toMatchObject({
      state: 'failed',
      error: '暂时无法读取（平台按用户名查询失败）',
      done: true,
    })
    // Asked again as the same record.
    retryRecord(ctx, job.submissionId)
    expect(recordDetail(ctx.db, job.submissionId)).toMatchObject({
      state: 'queued',
    })
  })

  test('a handle a post mentions is saved under its id, never as a handle', async () => {
    const status = JSON.parse(
      readFileSync(
        new URL('../platforms/x/testdata/post.json', import.meta.url),
        'utf8',
      ),
    ).status
    const author = status.author.id
    const { ctx } = setup(
      (path) =>
        path === '/Mentioned' || path === '/id:55'
          ? user('55', 'Mentioned')
          : path === `/id:${author}`
            ? user(author, 'fixture_user')
            : notFound,
      undefined,
      {
        ...status,
        text: 'hi @Mentioned',
        raw_text: { text: 'hi @Mentioned' },
        // Nothing to download here.
        media: { all: [] },
        author: { ...status.author, avatar_url: '', banner_url: '' },
      },
    )
    const job = submit(ctx, {
      url: `https://x.com/fixture_user/status/${status.id}`,
    })
    await ctx.queue.drain()
    expect(recordDetail(ctx.db, job.submissionId)).toMatchObject({
      state: 'complete',
    })
    expect(
      ctx.db
        .select({ id: collections.externalId })
        .from(collections)
        .where(eq(collections.kind, 'profile'))
        .all()
        .map((row) => row.id)
        .toSorted(),
    ).toEqual(['55', author].toSorted())
    expect(handleKeyed(ctx)).toEqual([])
  })

  test("X's own answer that no account goes by it fails the request at once", async () => {
    const { ctx, asked } = setup(
      () => notFound,
      () => notFound,
    )
    const job = submit(ctx, { url: 'https://x.com/nobody' })
    await ctx.queue.drain()
    expect(asked).toEqual(['/nobody', 'session:nobody'])
    expect(recordDetail(ctx.db, job.submissionId)).toMatchObject({
      state: 'failed',
      error: '没有使用这个用户名的账号',
    })
    expect(
      ctx.db.select().from(jobs).where(eq(jobs.type, 'identify')).all(),
    ).toEqual([])
  })
})

describe('profiles saved by handle before', () => {
  /** A profile saved by handle, as the rule before allowed. */
  function saved(c: CaptureContext, id: string, handle: string) {
    c.db
      .insert(collections)
      .values({
        id,
        platform: 'x',
        kind: 'profile',
        externalId: `handle:${handle}`,
        url: `https://x.com/${handle}`,
        providerId: 'fxtwitter',
      })
      .run()
    c.db
      .insert(library)
      .values({
        collectionId: id,
        providerId: 'fxtwitter',
        adapterId: 'x',
        note: 'mine',
      })
      .run()
    c.db
      .insert(captures)
      .values({
        id: `k${id}`,
        collectionId: id,
        providerId: 'fxtwitter',
        adapterId: 'x',
        scope: 'public',
        state: 'failed',
        error: '账号不存在或已改名',
      })
      .run()
  }

  test('folds into its account by what the library knows, keeping its records, tags and note', async () => {
    const { ctx } = setup(() => notFound)
    listed(ctx, VUEUSE, 'VueUse')
    listed(ctx, '7', 'alice')
    saved(ctx, 'h1', 'vueuse')
    saved(ctx, 'h2', 'alice')
    // The account is saved already under its id for one of them.
    ctx.db
      .insert(collections)
      .values({
        id: 'u7',
        platform: 'x',
        kind: 'profile',
        externalId: '7',
        url: 'https://x.com/i/user/7',
        providerId: 'fxtwitter',
      })
      .run()
    ctx.db.insert(tags).values({ id: 't', name: 'tag' }).run()
    ctx.db
      .insert(collectionTags)
      .values({ collectionId: 'h2', tagId: 't' })
      .run()
    expect(await settleHandleProfiles(ctx)).toMatchObject({
      local: 2,
      waiting: 0,
    })
    expect(handleKeyed(ctx)).toEqual([])
    const vue = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.externalId, VUEUSE))
      .get()!
    expect(
      ctx.db.select().from(captures).where(eq(captures.id, 'kh1')).get(),
    ).toMatchObject({ collectionId: vue.id })
    expect(ctx.db.select().from(library).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectionId: vue.id, note: 'mine' }),
        expect.objectContaining({ collectionId: 'u7', note: 'mine' }),
      ]),
    )
    expect(ctx.db.select().from(collectionTags).all()).toEqual([
      { collectionId: 'u7', tagId: 't' },
    ])
    expect(
      ctx.db
        .select({ externalId: collectionIdentityAliases.externalId })
        .from(collectionIdentityAliases)
        .all()
        .map((row) => row.externalId)
        .toSorted(),
    ).toEqual(['handle:alice', 'handle:vueuse'])
  })

  test('folds go a batch to a write transaction, pacing between', async () => {
    const { ctx } = setup(() => notFound)
    for (let i = 0; i < FOLD_BATCH * 2 + 5; i++) {
      listed(ctx, String(100 + i), `user${i}`)
      saved(ctx, `h${i}`, `user${i}`)
    }
    let paced = 0
    ctx.pace = async () => {
      paced++
    }
    expect(await settleHandleProfiles(ctx)).toMatchObject({
      local: FOLD_BATCH * 2 + 5,
    })
    expect(paced).toBe(2)
    expect(handleKeyed(ctx)).toEqual([])
  })

  test('one with content is left alone', async () => {
    const { ctx } = setup(() => notFound)
    listed(ctx, VUEUSE, 'VueUse')
    saved(ctx, 'h1', 'vueuse')
    ctx.db
      .update(collections)
      .set({ currentRevision: 'r' })
      .where(eq(collections.id, 'h1'))
      .run()
    expect(await settleHandleProfiles(ctx, { network: true })).toMatchObject({
      local: 0,
      identified: 0,
    })
    expect(handleKeyed(ctx)).toHaveLength(1)
  })

  test('the others are looked up while idle, spaced out, and given up on as failed requests', async () => {
    let known = false
    const { ctx, asked, advance } = setup((path) =>
      path === '/found' && known ? user('9', 'found') : notFound,
    )
    saved(ctx, 'h1', 'found')
    saved(ctx, 'h2', 'lost')
    const waits: number[] = []
    const settle = () =>
      settleHandleProfiles(ctx, {
        network: true,
        wait: async (ms) => waits.push(ms),
      })
    // Without the network, only what the library knows.
    expect(await settleHandleProfiles(ctx)).toMatchObject({ waiting: 2 })
    expect(asked).toEqual([])
    expect(await settle()).toMatchObject({ identified: 0, waiting: 2 })
    expect(asked).toEqual(['/found', '/lost'])
    // One a second.
    expect(waits).toEqual([1000])
    // Not again before the spacing.
    expect(await settle()).toMatchObject({ waiting: 2 })
    expect(asked).toHaveLength(2)
    known = true
    advance(FOLD_SPACING_MS)
    expect(await settle()).toMatchObject({ identified: 1, waiting: 1 })
    expect(
      ctx.db.select().from(captures).where(eq(captures.id, 'kh1')).get(),
    ).toMatchObject({ collectionId: expect.not.stringMatching('h1') })
    for (let i = 3; i < FOLD_ATTEMPTS; i++) {
      advance(FOLD_SPACING_MS)
      await settle()
    }
    advance(FOLD_SPACING_MS)
    expect(await settle()).toMatchObject({ failed: 1 })
    // A failed request of its link; the collection leaves the library.
    expect(listRecords(ctx.db).items).toMatchObject([
      {
        url: 'https://x.com/lost',
        input: 'https://x.com/lost',
        state: 'failed',
        error: '暂时无法读取（平台按用户名查询失败）',
      },
    ])
    expect(
      ctx.db.select().from(library).where(eq(library.collectionId, 'h2')).get(),
    ).toBeUndefined()
    expect(
      ctx.db.select().from(collections).where(eq(collections.id, 'h2')).get()
        ?.unreferencedAt,
    ).toBeInstanceOf(Date)
  })
})
