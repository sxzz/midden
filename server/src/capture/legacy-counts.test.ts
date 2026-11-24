import { asc, eq } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import { captures, revisions } from '#db/schema.ts'
import { listCounts } from '#library/read.ts'
import { Platforms } from '#platforms/registry.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { fillLegacyCounts } from './legacy-counts.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const KEY = 'fake.profile/100'

/**
 * The fake platform declares no counts for profiles, so profile captures are
 * stored as the Go service stored every capture before 2026-10-15: counts in
 * the entity data, a new version whenever one changed, no `metrics`. The
 * platform as declared now names where they are.
 */
function declared(ctx: CaptureContext): Platforms {
  return new Platforms(
    ctx.platforms.all().map((platform) => ({
      ...platform,
      description: {
        ...platform.description,
        entityTypes: platform.description.entityTypes.map((type) =>
          type.name === 'fake.profile'
            ? {
                ...type,
                metricPaths: ['/metadata/followers', '/metadata/following'],
              }
            : type,
        ),
      },
    })),
  )
}

test('recovers counts imported captures kept in entity data', async () => {
  let metadata: Record<string, unknown> = { followers: 10, following: 1 }
  const made = libraryContext(() => ({
    text: 'profile',
    graph: graph([
      entity('root', 'fake.profile', '100', { name: 'A', metadata }),
    ]),
  }))
  ctx = made.ctx
  const first = await capture(ctx, 'https://fake.test/u/100')
  const id = first.collectionId
  const refresh = () => capture(ctx!, { refreshId: id })
  // The same counts: the revision is reused, and its counts are the first
  // capture's, not necessarily what this one saw.
  const same = await refresh()
  metadata = { followers: 12, following: 1 }
  const grown = await refresh()
  // Recorded counts are kept, even where the data says otherwise.
  metadata = { followers: 15, following: 1 }
  const recorded = await refresh()
  const kept = { [KEY]: { '/metadata/followers': 14 } }
  setMetrics(recorded.id, kept)
  // Nothing that is a count.
  metadata = { followers: -1, following: 'many' }
  const garbled = await refresh()
  // Other entities' counts stay; only the valid count is taken.
  metadata = { followers: 20, following: 2.5 }
  const mixed = await refresh()
  const other = { 'fake.post/9': { '/likes': 1 } }
  setMetrics(mixed.id, other)

  const revisionOf = (c: typeof first) =>
    ctx!.db
      .select({ captureId: revisions.captureId })
      .from(revisions)
      .where(eq(revisions.id, c.revisionId!))
      .get()!.captureId
  expect(revisionOf(same)).toBe(first.id)
  expect(revisionOf(grown)).toBe(grown.id)
  // Only the capture that recorded its counts has a point so far.
  expect(listCounts(ctx, id).points).toHaveLength(1)

  const platforms = declared(ctx)
  // One capture per batch, so batches follow each other.
  expect(fillLegacyCounts(ctx.db, platforms, 1)).toBe(3)
  expect(fillLegacyCounts(ctx.db, platforms)).toBe(0)

  const metrics = new Map(
    ctx.db
      .select({ id: captures.id, metrics: captures.metrics })
      .from(captures)
      .orderBy(asc(captures.id))
      .all()
      .map((row) => [row.id, row.metrics]),
  )
  expect(metrics.get(first.id)).toEqual({
    [KEY]: { '/metadata/followers': 10, '/metadata/following': 1 },
  })
  expect(metrics.get(same.id)).toBeNull()
  expect(metrics.get(grown.id)).toEqual({
    [KEY]: { '/metadata/followers': 12, '/metadata/following': 1 },
  })
  expect(metrics.get(recorded.id)).toEqual(kept)
  expect(metrics.get(garbled.id)).toBeNull()
  expect(metrics.get(mixed.id)).toEqual({
    ...other,
    [KEY]: { '/metadata/followers': 20 },
  })

  expect(
    listCounts(ctx, id).points.map((p) => [p.capture_id, p.counts]),
  ).toEqual([
    [first.id, { '/metadata/followers': 10, '/metadata/following': 1 }],
    [grown.id, { '/metadata/followers': 12, '/metadata/following': 1 }],
    [recorded.id, { '/metadata/followers': 14 }],
    [mixed.id, { '/metadata/followers': 20 }],
  ])

  function setMetrics(captureId: string, value: object) {
    ctx!.db
      .update(captures)
      .set({ metrics: value })
      .where(eq(captures.id, captureId))
      .run()
  }
})

test('leaves captures alone when no type declares counts there', async () => {
  const made = libraryContext(() => ({
    text: 'profile',
    graph: graph([
      entity('root', 'fake.profile', '100', { metadata: { followers: 3 } }),
    ]),
  }))
  ctx = made.ctx
  const first = await capture(ctx, 'https://fake.test/u/100')
  expect(fillLegacyCounts(ctx.db, ctx.platforms)).toBe(0)
  const row = ctx.db
    .select({ metrics: captures.metrics })
    .from(captures)
    .where(eq(captures.id, first.id))
    .get()
  expect(row?.metrics).toBeNull()
})
