import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { addAccount, type AccountsContext } from '#accounts/accounts.ts'
import { inlineReads, typeCatalog } from '#agent/runner.ts'
import { assets, captures } from '#db/schema.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import {
  fetchSessionTimeline,
  normalizeProfile,
  protectedPostsNote,
} from '#platforms/x/profile.ts'
import { CaptureStrategy } from '#platforms/x/strategy.ts'
import { progressMessage } from '#telegram/presentation.ts'
import { testContext } from '#testing/context.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import { SYSTEM } from '#users/principal.ts'
import { captureHandlers } from './handlers.ts'
import {
  captureURL,
  collectionProgress,
  collectionReasons,
  recordDetail,
  recordMembers,
} from './records.ts'
import { retryRecordFailed } from './retries.ts'
import {
  recordProfiles,
  startUpdate,
  updateDetail,
  updateMembers,
  updateRecord,
} from './updates.ts'

// The case behind #131: a protected account the capture account does not
// follow. FxTwitter gives its profile; UserTweets answers only that the
// user is unavailable.

const ID = '2119008349526343680'
const URL_ = `https://x.com/i/user/${ID}`
const UNAVAILABLE =
  '{"data":{"user":{"result":{"__typename":"UserUnavailable"}}}}'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])

const user = {
  type: 'profile',
  id: ID,
  name: 'Hang Seng Bank',
  screen_name: 'Hang_Seng_Bank',
  protected: true,
  avatar_url: `https://pbs.twimg.com/profile_images/1/a_400x400.jpg`,
  banner_url: `https://pbs.twimg.com/profile_banners/${ID}/1`,
}

/** A timeline with one post, once the capture account may see it. */
function timeline() {
  const tweet = {
    __typename: 'Tweet',
    rest_id: '42',
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: ID,
          legacy: {
            screen_name: user.screen_name,
            name: user.name,
            protected: true,
          },
        },
      },
    },
    legacy: {
      id_str: '42',
      full_text: 'hello',
      created_at: 'Tue Nov 24 08:00:00 +0000 2026',
      entities: { urls: [], hashtags: [], user_mentions: [] },
      extended_entities: { media: [] },
    },
  }
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    {
                      entryId: 'tweet-42',
                      content: {
                        itemContent: {
                          __typename: 'TimelineTweet',
                          tweet_results: { result: tweet },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }
}

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

async function setup() {
  const { logger, entries } = recordingLogger()
  const source = { following: false, timelines: 0 }
  const strategy = new CaptureStrategy(
    undefined,
    async (id) => normalizeProfile(user, id, 'fxtwitter'),
    undefined,
    (result, credential, signal, _fetcher, cursor, pageSize, since) =>
      fetchSessionTimeline(
        result,
        credential,
        signal,
        async () => {
          source.timelines++
          return source.following
            ? Response.json(timeline())
            : new Response(UNAVAILABLE, {
                headers: { 'content-type': 'application/json' },
              })
        },
        cursor,
        pageSize,
        since,
      ),
  )
  ctx = testContext({
    platforms: [
      createXPlatform(strategy, async () => ({
        accountId: '443',
        username: 'XiaoZhi443',
      })),
    ],
    handlers: captureHandlers,
    // Avatars and banners.
    fetch: async () => new Response(JPEG),
    logger,
  })
  const account = await addAccount(ctx, 'x', {
    credential: Buffer.from(
      JSON.stringify({
        auth_token: 'a'.repeat(40),
        csrf_token: 'b'.repeat(64),
      }),
    ),
  })
  ctx.queue.start()
  return { ctx, entries, source, account }
}

const reader = (c: AccountsContext) =>
  inlineReads({ db: c.db, blobs: c.blobs, types: typeCatalog(c.platforms) })

describe('a protected account whose posts the capture account may not see', () => {
  test('is saved complete with a note: no anomaly, no automatic retry, retried by hand once it may see them', async () => {
    const { ctx, entries, source, account } = await setup()
    const job = captureURL(ctx, URL_)
    await ctx.queue.drain()

    // Asked once: the answer is no failure, so nothing retries it.
    expect(source.timelines).toBe(1)
    const capture = ctx.db
      .select()
      .from(captures)
      .where(eq(captures.id, job.id))
      .get()!
    expect(capture.state).toBe('complete')
    expect(capture.error).toBe(protectedPostsNote)
    // The profile, its avatar and banner are saved as usual.
    expect(
      ctx.db
        .select({ purpose: assets.purpose, state: assets.state })
        .from(assets)
        .where(eq(assets.captureId, capture.id))
        .all()
        .toSorted((a, b) => a.purpose.localeCompare(b.purpose)),
    ).toEqual([
      { purpose: 'avatar', state: 'ready' },
      { purpose: 'banner', state: 'ready' },
    ])

    // The record: complete, no posts, nothing failed; 重试本页 stays.
    const record = recordDetail(ctx.db, job.submissionId)
    expect(record).toMatchObject({
      state: 'complete',
      error: protectedPostsNote,
      members: { total: 0, partial: 0, failed: 0 },
      retryable: 0,
      pages: { failed: true, more: false },
    })
    expect(recordProfiles(ctx.db, record)[0]).toMatchObject({
      state: 'complete',
      error: protectedPostsNote,
    })
    // It says why there are no posts, but it is no failure reason.
    expect(
      collectionReasons(
        ctx.db,
        collectionProgress(ctx.db, job.submissionId).pages,
      ),
    ).toEqual([])
    expect(recordMembers(ctx.db, job.submissionId, 'problem').items).toEqual([])

    // The bot's progress says the same, and offers 重试本页.
    const progress = collectionProgress(ctx.db, job.submissionId)
    const message = progressMessage(
      {
        submissionId: job.submissionId,
        collectionId: job.collectionId,
        url: URL_,
        input: URL_,
        rootState: capture.state,
        rootError: capture.error,
        ...progress,
        pageError: progress.error === 'partial_pages',
        reasons: [],
      },
      { group: true },
    )
    expect(message.text).toContain(protectedPostsNote)
    expect(message.text).not.toContain('未完整保存原因')
    expect(message.keyboard!.flat().map((b) => b.text)).toContain('重试本页')

    // Logged with the capture, the platform, the capture account and what
    // X answered; no secrets.
    const logged = entries.find(
      (e) => e.msg === 'platform call went on past an error',
    )
    expect(logged).toMatchObject({
      level: levels.warn,
      captureId: capture.id,
      platform: 'x',
      connectionId: account.id,
      errorCode: 'UNAVAILABLE',
      errorMessage: '平台返回的时间线无效',
      errorDetails: { typename: 'UserUnavailable' },
      upstream: {
        provider: 'x-graphql',
        operation: 'UserTweets',
        status: 200,
        body: UNAVAILABLE,
      },
    })
    expect(JSON.stringify(entries)).not.toContain('a'.repeat(40))

    // An update of it: complete, its profile counted as updated, the note on
    // its part and member, and in the agent API's notes.
    const update = startUpdate(ctx, {
      target: 'collection',
      id: job.collectionId,
    })
    await ctx.queue.drain()
    expect(source.timelines).toBe(2)
    expect(updateRecord(ctx.db, update)).toMatchObject({
      state: 'complete',
      members: { complete: 1, partial: 0, failed: 0, updated: 1 },
      retryable: 0,
    })
    expect(updateDetail(ctx.db, update).profiles[0]).toMatchObject({
      state: 'complete',
      error: protectedPostsNote,
      retryable: false,
    })
    expect(updateMembers(ctx.db, update, 'problem').items).toEqual([])
    expect(updateMembers(ctx.db, update, 'updated').items).toEqual([
      expect.objectContaining({ state: 'complete', error: protectedPostsNote }),
    ])
    expect(retryRecordFailed(ctx, update)).toBe(0)
    const status = reader(ctx).run(SYSTEM, 'status', { id: update }) as any
    expect(await status).toMatchObject({
      kind: 'update',
      state: 'complete',
      notes: [{ url: URL_, text: protectedPostsNote }],
    })
    expect((await status).error).toBeUndefined()

    // Once the capture account follows it, the next update reads its posts.
    source.following = true
    const again = startUpdate(ctx, {
      target: 'collection',
      id: job.collectionId,
    })
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, again).members).toMatchObject({
      total: 2,
      complete: 2,
    })
    expect(updateDetail(ctx.db, again).profiles[0]).toMatchObject({
      state: 'complete',
      error: '',
      posts: { total: 1 },
    })
    expect(
      (await reader(ctx).run(SYSTEM, 'status', { id: again })) as any,
    ).not.toHaveProperty('notes')
  })
})
