import { Buffer } from 'node:buffer'
import { captureHandlers } from '#capture/handlers.ts'
import { resolveOptions } from '#capture/options.ts'
import { captureURL } from '#capture/records.ts'
import { status } from '#platforms/rpc.ts'
import { testContext } from '#testing/context.ts'
import {
  FakeFailure,
  fakePlatform,
  fakeProfile,
  postGraph,
  type FakeRelations,
} from '#testing/fake-platform.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchRequest } from '#platforms/protocol.ts'

// A world of fake profiles and posts, for tests of updates.

let ctx: AccountsContext | undefined

/** Stop the queue of the world made last. */
export async function stopWorld() {
  await ctx?.queue.stop()
  ctx = undefined
}

/** What the fake source says now. */
export interface World {
  /** Post ids on each profile's timeline, newest first. */
  timelines: Record<string, number[]>
  pageSize: number
  counts: Record<string, { following: number; followers: number }>
  lists: Record<string, { following?: string[]; followers?: string[] }>
  broken: Set<string>
  requests: FetchRequest[]
}

export const target = (id: number) => ({
  url: `https://fake.test/p/${id}`,
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '',
  mediaTypes: [],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
})

export function setup(
  world: Partial<World> = {},
  options: { run?: boolean; timelineCap?: number } = {},
) {
  const state: World = {
    timelines: {},
    pageSize: 3,
    counts: {},
    lists: {},
    broken: new Set(),
    requests: [],
    ...world,
  }
  const relations: FakeRelations = (req) => ({
    accounts: (state.lists[req.externalId]?.[req.list] ?? []).map((id) =>
      fakeProfile(id),
    ),
    nextCursor: '',
  })
  ctx = testContext({
    platforms: [
      fakePlatform(
        {
          current: (req) => {
            state.requests.push(req)
            if (state.broken.has(req.externalId))
              throw new FakeFailure(status.PERMISSION_DENIED, 'no access')
            if (req.kind === 'post')
              return { text: 'post', graph: postGraph(req.externalId, {}) }
            const id = req.externalId
            const posts = state.timelines[id] ?? []
            const start = Number(req.pageCursor || 0)
            const next = start + state.pageSize
            return {
              ...fakeProfile(id, {
                username: `u${id}`,
                metadata: state.counts[id] ?? { following: 0, followers: 0 },
              }),
              providerId: req.providerId,
              relatedTargets: posts.slice(start, next).map(target),
              nextPageCursor: next < posts.length ? String(next) : '',
            }
          },
        },
        { current: relations },
      ),
    ],
    handlers: captureHandlers,
    timelineCap: options.timelineCap,
  })
  if (options.run !== false) ctx.queue.start()
  return { ctx, state }
}

/** Save a link; a profile with its first page, as the world pages by 3. */
export async function save(c: AccountsContext, url: string) {
  const job = captureURL(c, url, undefined, resolveOptions({ count: 3 }))
  await c.queue.drain()
  return job.collectionId
}
