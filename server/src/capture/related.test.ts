import { Buffer } from 'node:buffer'
import { eq, like } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { captures, collections, submissions } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { stopCollection } from './related.ts'
import { submit } from './submit.ts'
import type { FetchRequest, RelatedTarget } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const member = (id: number, extra: Partial<RelatedTarget> = {}) => ({
  url: `https://fake.test/p/${id}`,
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '2026-01-01T00:00:00Z',
  mediaTypes: [] as string[],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
  ...extra,
})

/** A profile with `pages` timeline pages of `size` posts each. */
function setup(
  pages: number,
  size: number,
  onFetch?: (req: FetchRequest) => void,
) {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => {
          onFetch?.(req)
          if (req.kind === 'post')
            return {
              text: `post ${req.externalId}`,
              graph: postGraph(req.externalId, {}),
            }
          const page = Number(req.pageCursor || 0)
          return {
            text: 'profile',
            relatedTargets: [
              ...Array.from({ length: size }, (_, i) =>
                member(page * size + i + 1),
              ),
              // An account mentioned on the page: a reference, not a member.
              member(0, { url: 'https://fake.test/u/friend', postType: '' }),
            ],
            nextPageCursor: page + 1 < pages ? String(page + 1) : '',
          }
        },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  return ctx
}

function memberIds(c: CaptureContext) {
  return c.db
    .select({ id: collections.externalId })
    .from(collections)
    .where(eq(collections.kind, 'post'))
    .all()
    .map((row) => Number(row.id))
    .toSorted((a, b) => a - b)
}

describe('related', () => {
  test('a profile page submits its members and references', async () => {
    const c = setup(3, 2)
    submit(c, {
      url: 'https://fake.test/u/someone',
      options: resolveOptions({ count: 2 }),
    })
    await c.queue.drain()
    // Without options, one page.
    expect(memberIds(c)).toEqual([1, 2])
    const friend = c.db
      .select()
      .from(captures)
      .innerJoin(collections, eq(collections.id, captures.collectionId))
      .where(eq(collections.externalId, 'handle:friend'))
      .get()!
    // A referenced profile is captured but never expands.
    expect(friend.captures).toMatchObject({
      automatic: true,
      isCollection: false,
    })
    expect(
      c.db
        .select()
        .from(submissions)
        .where(like(submissions.idemKey, 'related:%'))
        .all(),
    ).toHaveLength(3)
  })

  test('options continue across pages until the budget is spent', async () => {
    const c = setup(5, 2)
    submit(c, {
      url: 'https://fake.test/u/someone',
      options: resolveOptions({ posts: 'max', count: 5 }),
    })
    await c.queue.drain()
    // The last page outruns the budget and is still submitted whole: the
    // next page would start after it.
    expect(memberIds(c)).toEqual([1, 2, 3, 4, 5, 6])
    expect(
      c.db
        .select()
        .from(submissions)
        .where(like(submissions.idemKey, 'batch:%'))
        .all(),
    ).toHaveLength(2)
  })

  test('filtered members neither count nor stop the paging', async () => {
    const c = setup(3, 2)
    submit(c, {
      url: 'https://fake.test/u/someone',
      options: resolveOptions({ posts: 'max', media_only: true }),
    })
    await c.queue.drain()
    // No member has media: none are submitted, yet every page is read.
    expect(memberIds(c)).toEqual([])
    expect(
      c.db.select().from(captures).where(eq(captures.isCollection, true)).all(),
    ).toHaveLength(3)
  })

  test('a stopped collection submits nothing more', async () => {
    const c = setup(3, 2)
    const job = submit(c, {
      url: 'https://fake.test/u/someone',
      options: resolveOptions(),
    })
    stopCollection(c, job.submissionId)
    await c.queue.drain()
    expect(memberIds(c)).toEqual([])
    expect(
      c.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, job.submissionId))
        .get(),
    ).toMatchObject({ collectionStopped: true, relatedState: 'complete' })
    expect(() => stopCollection(c, job.submissionId)).not.toThrow()
  })

  test('references of references never expand', async () => {
    const fetched: string[] = []
    const c = setup(1, 0, (req) => fetched.push(req.url))
    // Each post references the next. A top-level post's reference may
    // hydrate its own references; theirs never do.
    const handle = c.platforms.byId('fake')
    const original = handle.fetch
    handle.fetch = async (req, signal) => {
      const result = await original(req, signal)
      if (req.kind === 'post') {
        const next = Number(req.externalId) + 1
        result.relatedTargets = [member(next)]
      }
      return result
    }
    submit(c, { url: 'https://fake.test/p/1' })
    await c.queue.drain()
    expect(fetched).toEqual([
      'https://fake.test/p/1',
      'https://fake.test/p/2',
      'https://fake.test/p/3',
    ])
  })
})
