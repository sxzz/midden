import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync } from 'node:fs'
import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captureMetrics,
  captures,
  captureStaging,
  captureTargets,
  catalog,
  collections,
  submissions,
} from '#db/schema.ts'
import {
  collectionsById,
  getCollection,
  listCounts,
  listHistory,
} from '#library/read.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { resolveOptions } from './options.ts'
import { recordDetail } from './records.ts'
import { pruneStaging } from './staging.ts'
import { submit } from './submit.ts'
import { previewUpdate } from './updates.ts'
import type { FetchRequest, RelatedTarget } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const PROFILE = 'https://fake.test/u/100'

const member = (id: number, prefetch = ''): RelatedTarget => ({
  url: `https://fake.test/p/${id}`,
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '2026-01-01T00:00:00Z',
  mediaTypes: [],
  postType: 'post',
  prefetch: Buffer.from(prefetch),
  listedAt: '',
  pinned: false,
})

/**
 * A profile whose timeline lists two posts, the first with a prefetch; each
 * fetch reads higher counts than the one before.
 */
function setup() {
  const seen: FetchRequest[] = []
  let reads = 0
  const c = testContext({
    platforms: [
      fakePlatform(
        { current: (req) => fetch(req) },
        // Lists are never read here; the profile's counts of them are.
        { current: () => ({ accounts: [], nextCursor: '' }) },
      ),
    ],
    handlers: captureHandlers,
  })
  c.queue.start()
  const fetch = (req: FetchRequest) => {
    seen.push(req)
    reads++
    if (req.kind === 'post')
      return {
        text: `post ${req.externalId}`,
        graph: postGraph(req.externalId, { likes: reads }),
      }
    return {
      ...fakeProfile('100', {
        metadata: { followers: 10 + reads, following: 5 },
      }),
      relatedTargets: [member(1, '{"cached":1}'), member(2)],
    }
  }
  ctx = c
  return { c, seen }
}

const options = resolveOptions({ count: 2 })

describe('capture staging', () => {
  test('a listing hands its members their prefetch, then nothing is left staged', async () => {
    const { c, seen } = setup()
    submit(c, { url: PROFILE, options })
    await c.queue.drain()

    const prefetchOf = (id: string) =>
      Buffer.from(
        seen.find((req) => req.kind === 'post' && req.externalId === id)!
          .prefetch,
      ).toString()
    expect(prefetchOf('1')).toBe('{"cached":1}')
    expect(prefetchOf('2')).toBe('')
    // The targets stay, without their prefetches.
    const [listing] = c.db.select().from(captureTargets).all()
    expect(listing!.targets.map((t) => t.url)).toEqual([
      'https://fake.test/p/1',
      'https://fake.test/p/2',
    ])
    expect(JSON.stringify(listing!.targets)).not.toContain('prefetch')
    expect(c.db.select().from(captureStaging).all()).toEqual([])
    // Every finished capture has its counts beside it.
    expect(c.db.select().from(captureMetrics).all()).toHaveLength(3)
  })

  test('what a finished capture left staged goes after a day', async () => {
    const clock = { now: Date.now() }
    const { c } = setup()
    c.now = () => clock.now
    const done = submit(c, { url: 'https://fake.test/p/1' })
    await c.queue.drain()
    c.db
      .insert(captureStaging)
      .values({ captureId: done.id, targetPrefetch: ['e30='] })
      .run()
    clock.now += 23 * 60 * 60_000
    expect(pruneStaging(c)).toBe(0)
    clock.now += 2 * 60 * 60_000
    expect(pruneStaging(c)).toBe(1)
    expect(c.db.select().from(captureStaging).all()).toEqual([])
  })
})

/** Put a database back to the captures table before the migration. */
function rewind(c: CaptureContext) {
  c.db.$client.exec(`
    ALTER TABLE captures ADD payload text;
    ALTER TABLE captures ADD related_targets text DEFAULT '[]' NOT NULL;
    ALTER TABLE captures ADD prefetch blob;
    ALTER TABLE captures ADD metrics text;
    UPDATE captures SET
      related_targets = coalesce((SELECT targets FROM capture_targets
        WHERE capture_id = captures.id), '[]'),
      metrics = (SELECT metrics FROM capture_metrics
        WHERE capture_id = captures.id),
      payload = (SELECT payload FROM capture_staging
        WHERE capture_id = captures.id),
      prefetch = (SELECT prefetch FROM capture_staging
        WHERE capture_id = captures.id);
    DROP TABLE capture_targets;
    DROP TABLE capture_metrics;
    DROP TABLE capture_staging;`)
}

function migrate(c: CaptureContext) {
  const folder = new URL('../../drizzle/', import.meta.url)
  const name = readdirSync(folder).find((n) =>
    n.endsWith('_capture_side_tables'),
  )
  for (const statement of readFileSync(
    new URL(`${name}/migration.sql`, folder),
    'utf8',
  ).split('--> statement-breakpoint'))
    c.db.$client.exec(statement)
}

describe('the side table migration', () => {
  test('moves targets, counts and staged data out of captures, and reads the same', async () => {
    const { c } = setup()
    const first = submit(c, { url: PROFILE, options })
    await c.queue.drain()
    // A second capture of the profile: history and counts have two points.
    submit(c, { refreshId: first.collectionId, options })
    await c.queue.drain()
    const ids = c.db
      .select({ id: collections.id })
      .from(collections)
      .orderBy(asc(collections.id))
      .all()
      .map((row) => row.id)
    const profile = c.db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.kind, 'profile'))
      .get()!.id
    const reads = () => ({
      collections: ids.map((id) => getCollection(c, id)),
      byId: [...collectionsById(c, ids).entries()],
      history: listHistory(c, profile),
      counts: listCounts(c, profile),
      catalog: c.db
        .select()
        .from(catalog)
        .orderBy(asc(catalog.collectionId))
        .all(),
      record: recordDetail(c.db, first.submissionId),
      preview: previewUpdate(c, { target: 'collection', id: profile }),
    })
    const before = reads()
    expect(before.preview.counts).toEqual({ followers: 11, following: 5 })
    expect(before.counts.points).toHaveLength(2)

    rewind(c)
    // Prefetches a listing kept: one still to be submitted, one never.
    const listings = c.db.all<{ id: string; targets: string }>(
      `SELECT c.id, c.related_targets AS targets FROM captures c
       WHERE c.related_targets <> '[]' ORDER BY c.created_at`,
    )
    expect(listings).toHaveLength(2)
    const withPrefetch = (targets: string) =>
      JSON.stringify(
        (JSON.parse(targets) as object[]).map((target, i) => ({
          ...target,
          ...(i === 0 ? { prefetch: 'e30=' } : {}),
        })),
      )
    for (const listing of listings)
      c.db.$client
        .prepare('UPDATE captures SET related_targets = ? WHERE id = ?')
        .run(withPrefetch(listing.targets), listing.id)
    c.db
      .update(submissions)
      .set({ relatedState: 'pending' })
      .where(eq(submissions.captureId, listings[1]!.id))
      .run()
    // A capture still running, with what it staged.
    const running = c.db
      .select({ id: captures.id })
      .from(captures)
      .where(eq(captures.collectionId, ids[0]!))
      .get()!.id
    c.db.$client
      .prepare(
        `UPDATE captures SET state = 'downloading', payload = '{"text":"x"}',
          prefetch = X'7b7d' WHERE id = ?`,
      )
      .run(running)

    migrate(c)
    expect(
      c.db
        .select()
        .from(captureStaging)
        .orderBy(asc(captureStaging.captureId))
        .all(),
    ).toEqual(
      [
        {
          captureId: listings[1]!.id,
          prefetch: null,
          payload: null,
          targetPrefetch: ['e30=', null],
        },
        {
          captureId: running,
          prefetch: Buffer.from('{}'),
          payload: { text: 'x' },
          targetPrefetch: null,
        },
      ].toSorted((a, b) => a.captureId.localeCompare(b.captureId)),
    )
    expect(
      JSON.stringify(c.db.select().from(captureTargets).all()),
    ).not.toContain('prefetch')
    const columns = c.db
      .all<{ name: string }>(`SELECT name FROM pragma_table_info('captures')`)
      .map((row) => row.name)
    for (const gone of ['payload', 'related_targets', 'prefetch', 'metrics'])
      expect(columns).not.toContain(gone)

    c.db.$client
      .prepare(`UPDATE captures SET state = 'complete' WHERE id = ?`)
      .run(running)
    expect(reads()).toEqual(before)
  })
})
