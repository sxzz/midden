import { Buffer } from 'node:buffer'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { sha256Hex } from '#capture/json.ts'
import { mediaKey } from '#capture/media-key.ts'
import { submit, type SubmitInput } from '#capture/submit.ts'
import {
  assets,
  blobs,
  blobThumbnails,
  captures,
  collections,
  library,
  mediaGarbage,
  removedMedia,
  videoRemovals,
} from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import { entity, expectCatalogFresh, graph } from '#testing/library.ts'
import { localUsage } from '#usage/local.ts'
import { updateAnnotation } from './annotations.ts'
import { deleteCollection } from './delete.ts'
import { storageUsed } from './read.ts'
import {
  latestVideoRemoval,
  previewVideoRemoval,
  startVideoRemoval,
  VIDEO_BATCH,
} from './video-removal.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse, Resource } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`
const member = (id: string) => ({
  url: post(id),
  refreshAfterSeconds: 0,
  updatedAt: '',
  publishedAt: '',
  mediaTypes: [] as string[],
  postType: 'post',
  prefetch: Buffer.alloc(0),
  listedAt: '',
  pinned: false,
})

/** A video file of its own for each path; a photo likewise. */
const VIDEO = (name: string) =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.from(name.padEnd(64, '.')),
  ])
const PHOTO = (name: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(name)])

/** Media of a post by name: `v:<name>` a video, `i:<name>` a photo. */
function resource(name: string): Resource {
  const [kind, key] = name.split(':') as ['v' | 'i', string]
  return {
    url: `https://m.test/${key}.${kind === 'v' ? 'mp4' : 'jpg'}`,
    kind: kind === 'v' ? 'video' : 'image',
    immutableKey: `fake:media:${kind}:${key}`,
    altText: '',
    sensitive: false,
    purpose: '',
  }
}

interface Account {
  wrote: string[]
  reposted: string[]
}
interface Post {
  author: string
  quotes?: string
  mentions?: string[]
  media?: string[]
}

/**
 * Accounts and what their timelines list, as in deleting an account with
 * its posts; each post has media. Every file fetched is counted.
 */
function setup(accounts: Record<string, Account>, posts: Record<string, Post>) {
  const requests: string[] = []
  const c = testContext({
    platforms: [
      fakePlatform({
        current: (req): Partial<FetchResponse> => {
          if (req.kind === 'profile') {
            const account = accounts[req.externalId]!
            return {
              text: `profile ${req.externalId}`,
              graph: graph(
                [
                  entity('root', 'fake.profile', req.externalId),
                  ...account.reposted.map((id) => entity(id, 'fake.post', id)),
                ],
                ...account.reposted.map(
                  (id) => ['root', 'reposted', id] as [string, string, string],
                ),
              ),
              relatedTargets: [...account.wrote, ...account.reposted].map(
                member,
              ),
            }
          }
          const {
            author,
            quotes,
            mentions = [],
            media = [],
          } = posts[req.externalId]!
          return {
            text: `post ${req.externalId}`,
            resources: media.map(resource),
            graph: graph(
              [
                entity(
                  'root',
                  'fake.post',
                  req.externalId,
                  {},
                  media.map((_, i) => i),
                ),
                entity('author', 'fake.profile', author),
                ...(quotes ? [entity('quote', 'fake.post', quotes)] : []),
                ...mentions.map((id) => entity(`m${id}`, 'fake.profile', id)),
              ],
              ['root', 'authored_by', 'author'],
              ...mentions.map(
                (id) =>
                  ['root', 'mentions', `m${id}`] as [string, string, string],
              ),
              ...(quotes
                ? [['root', 'quoted', 'quote'] as [string, string, string]]
                : []),
            ),
            relatedTargets: quotes ? [member(quotes)] : [],
          }
        },
      }),
    ],
    handlers: captureHandlers,
    fetch: (input) => {
      const url = new URL(String(input))
      requests.push(url.href)
      const name = url.pathname.slice(1)
      return Promise.resolve(
        new Response(name.endsWith('.mp4') ? VIDEO(name) : PHOTO(name)),
      )
    },
  })
  ctx = c
  c.queue.start()
  return { c, requests }
}

async function capture(c: CaptureContext, input: string | SubmitInput) {
  submit(c, typeof input === 'string' ? { url: input } : input)
  await c.queue.drain()
}

/** Saved collection ids by the platform's id of their root. */
function saved(c: CaptureContext): Record<string, string> {
  return Object.fromEntries(
    c.db
      .select({ id: collections.id, external: collections.externalId })
      .from(collections)
      .innerJoin(library, eq(library.collectionId, collections.id))
      .all()
      .map((row) => [row.external, row.id]),
  )
}

/** Each asset of a collection, in every capture, as `<url>=<state>`. */
function media(c: CaptureContext, id: string): string[] {
  return c.db
    .select({ url: assets.sourceUrl, state: assets.state })
    .from(assets)
    .innerJoin(captures, eq(captures.id, assets.captureId))
    .where(eq(captures.collectionId, id))
    .all()
    .map((a) => `${new URL(a.url).pathname.slice(1)}=${a.state}`)
    .toSorted()
}

const key = (name: string) =>
  mediaKey('fake', { immutableKey: `fake:media:v:${name}`, url: '' })

describe('removing a profile’s videos (删除所有视频)', () => {
  test('takes the videos of the posts deleting the profile with its posts would take', async () => {
    const { c, requests } = setup(
      {
        1: {
          wrote: ['mine', 'quoting', 'quoting2', 'direct', 'copy', 'pics'],
          reposted: ['alone', 'both', 'theirs', 'tagged', 'noted'],
        },
        3: { wrote: ['theirs', 'otherquote'], reposted: ['both'] },
        // Gone before, leaving a post of his that only mentions 1.
        5: { wrote: ['aside'], reposted: [] },
      },
      {
        // Written: its video goes, its photo stays.
        mine: { author: '1', media: ['v:mine', 'i:mine'] },
        // A quote of his, and the post it quotes, which came with it.
        quoting: { author: '1', quotes: 'quoted', media: ['v:quoting'] },
        quoted: { author: '9', media: ['v:quoted'] },
        // Reposted.
        alone: { author: '9', media: ['v:alone'] },
        // Only mentions him: not his, untouched.
        aside: { author: '5', mentions: ['1'], media: ['v:aside'] },
        // Kept: another saved account lists them.
        both: { author: '9', media: ['v:both'] },
        theirs: { author: '3', media: ['v:theirs'] },
        // Kept: saved on its own.
        direct: { author: '1', media: ['v:direct'] },
        // Kept: tags, a note.
        tagged: { author: '9', media: ['v:tagged'] },
        noted: { author: '9', media: ['v:noted'] },
        // Kept: a post of 3's that stays quotes it too.
        quoting2: { author: '1', quotes: 'quoted2' },
        quoted2: { author: '9', media: ['v:quoted2'] },
        otherquote: { author: '3', quotes: 'quoted2' },
        // One video of his goes; the other a post saved on its own has too.
        copy: { author: '1', media: ['v:copy', 'v:shared'] },
        keeper: { author: '9', media: ['v:shared'] },
        // Photos only.
        pics: { author: '1', media: ['i:pics'] },
      },
    )
    for (const id of ['1', '3', '5']) await capture(c, profile(id))
    deleteCollection(c.db, saved(c)[5]!)
    await capture(c, post('direct'))
    await capture(c, post('keeper'))
    let ids = saved(c)
    updateAnnotation(c.db, ids.tagged!, { tagNames: ['keep'] })
    updateAnnotation(c.db, ids.noted!, { note: 'mine' })
    // Captured twice: the video goes from both captures.
    await capture(c, { refreshId: ids.mine! })
    ids = saved(c)

    const sizeOf = (names: string[]) =>
      names.reduce((sum, name) => sum + VIDEO(`${name}.mp4`).length, 0)
    const going = ['mine', 'quoting', 'quoted', 'alone', 'copy']
    const thumbnail = await addThumbnail(c, 'mine.mp4')
    const usage = await usageOf(c)
    const used = storageUsed(c.db)
    const expected = {
      posts: 5,
      videos: 5,
      freed_bytes: sizeOf(going),
      shared: 0,
      // both, theirs; direct; tagged, noted; quoted2
      kept: { listed: 2, saved: 1, annotated: 2, quoted: 1 },
      // v:shared, which keeper has too
      elsewhere: 1,
    }
    expect(previewVideoRemoval(c, ids[1]!)).toEqual(expected)

    const started = startVideoRemoval(c, ids[1]!)
    expect(started).toMatchObject({ state: 'queued', removed: 0 })
    await c.queue.drain()
    // The job removed exactly what the preview said.
    expect(latestVideoRemoval(c.db, ids[1]!)).toMatchObject({
      id: started.id,
      state: 'complete',
      effect: expected,
      removed: 5,
    })
    expect(media(c, ids.mine!)).toEqual([
      'mine.jpg=ready',
      'mine.jpg=ready',
      'mine.mp4=removed',
      'mine.mp4=removed',
    ])
    for (const name of ['quoting', 'quoted', 'alone'])
      expect(media(c, ids[name]!)).toEqual([`${name}.mp4=removed`])
    expect(media(c, ids.copy!)).toEqual([
      'copy.mp4=removed',
      'shared.mp4=ready',
    ])
    for (const name of [
      'aside',
      'both',
      'theirs',
      'direct',
      'tagged',
      'noted',
      'quoted2',
    ])
      // Some were captured more than once, through several timelines.
      expect(new Set(media(c, ids[name]!))).toEqual(
        new Set([`${name}.mp4=ready`]),
      )
    expect(media(c, ids.keeper!)).toEqual(['shared.mp4=ready'])
    expect(media(c, ids.pics!)).toEqual(['pics.jpg=ready'])

    // Marked, so nothing downloads them again; the thumbnail is kept.
    expect(
      c.db
        .select({ key: removedMedia.mediaKey, kind: removedMedia.kind })
        .from(removedMedia)
        .all()
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    ).toEqual(
      going
        .map((name) => ({ key: key(name), kind: 'video' }))
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    )
    expect(
      c.db
        .select()
        .from(removedMedia)
        .where(eq(removedMedia.mediaKey, key('mine')))
        .get(),
    ).toMatchObject({ thumbnailKey: thumbnail.key, thumbnailSize: 6 })
    // The blobs went to media garbage, and the storage figures fell by the
    // bytes stated; the thumbnail is still counted, being kept.
    const hashes = going.map((name) => sha256Hex(VIDEO(`${name}.mp4`)))
    expect(
      c.db.select({ key: mediaGarbage.key }).from(mediaGarbage).all(),
    ).toEqual(expect.arrayContaining(hashes.map((hash) => ({ key: hash }))))
    expect(
      c.db
        .select()
        .from(blobs)
        .all()
        .filter((b) => hashes.includes(b.hash)),
    ).toEqual([])
    expect(storageUsed(c.db)).toBe(used - expected.freed_bytes)
    expect((await usageOf(c)).thumbnails).toEqual(usage.thumbnails)
    expectCatalogFresh(c)

    // The next capture of the profile and its posts downloads none of them.
    const fetched = requests.length
    for (const name of [...going, 'aside'])
      await capture(c, { refreshId: ids[name]! })
    expect(requests.slice(fetched)).toEqual([])
    expect(media(c, ids.alone!)).toEqual([
      'alone.mp4=removed',
      'alone.mp4=removed',
    ])
    // Nothing is left to remove; what stays still says why.
    expect(previewVideoRemoval(c, ids[1]!)).toEqual({
      ...expected,
      posts: 0,
      videos: 0,
      freed_bytes: 0,
    })
  })

  test('removes in batches, each video once', async () => {
    // Two batches.
    const count = VIDEO_BATCH + 3
    const names = Array.from({ length: count }, (_, i) => `p${i}`)
    const { c } = setup(
      { 1: { wrote: names, reposted: [] } },
      Object.fromEntries(
        names.map((name, i) => [
          name,
          // The first and the last post have the same video.
          { author: '1', media: [`v:${i === count - 1 ? 'p0' : name}`] },
        ]),
      ),
    )
    await capture(c, profile('1'))
    const ids = saved(c)
    const preview = previewVideoRemoval(c, ids[1]!)
    expect(preview).toMatchObject({ posts: count, videos: count - 1 })
    startVideoRemoval(c, ids[1]!)
    await c.queue.drain()
    expect(latestVideoRemoval(c.db, ids[1]!)).toMatchObject({
      state: 'complete',
      effect: preview,
      removed: count - 1,
    })
    expect(
      c.db
        .select({ state: assets.state })
        .from(assets)
        .all()
        .every((a) => a.state === 'removed'),
    ).toBe(true)
    expect(c.db.select().from(removedMedia).all()).toHaveLength(count - 1)
    expect(c.db.select().from(blobs).all()).toEqual([])
    // Capturing that many posts takes a while beside the other test files.
  }, 30_000)

  test('one removal at a time per profile, and only of a saved profile', async () => {
    const { c } = setup(
      { 1: { wrote: ['mine'], reposted: [] } },
      { mine: { author: '1', media: ['v:mine'] } },
    )
    await capture(c, profile('1'))
    const ids = saved(c)
    expect(() => previewVideoRemoval(c, ids.mine!)).toThrow(
      '内容不存在或已删除',
    )
    expect(() => startVideoRemoval(c, 'missing')).toThrow('内容不存在或已删除')
    // Asked twice before the job ran: one removal.
    const first = startVideoRemoval(c, ids[1]!)
    expect(startVideoRemoval(c, ids[1]!).id).toBe(first.id)
    await c.queue.drain()
    expect(latestVideoRemoval(c.db, ids[1]!)).toMatchObject({
      id: first.id,
      state: 'complete',
    })
    expect(startVideoRemoval(c, ids[1]!).id).not.toBe(first.id)
    await c.queue.drain()
    expect(latestVideoRemoval(c.db, ids[1]!)).toMatchObject({
      state: 'complete',
      effect: { videos: 0 },
    })
  })

  test('a removal whose profile went before it ran fails, saying so', async () => {
    const { c } = setup(
      { 1: { wrote: ['mine'], reposted: [] } },
      { mine: { author: '1', media: ['v:mine'] } },
    )
    await capture(c, profile('1'))
    const ids = saved(c)
    // Deleted before the job ran.
    const removal = startVideoRemoval(c, ids[1]!)
    deleteCollection(c.db, ids[1]!)
    await c.queue.drain()
    expect(
      c.db
        .select()
        .from(videoRemovals)
        .where(eq(videoRemovals.id, removal.id))
        .get(),
    ).toMatchObject({ state: 'failed', error: '内容不存在或已删除' })
    expect(media(c, ids.mine!)).toEqual(['mine.mp4=ready'])
  })
})

/** Give the video's blob a thumbnail, as the thumbnailer would. */
async function addThumbnail(c: CaptureContext, file: string) {
  const blob = c.db
    .select()
    .from(blobs)
    .where(eq(blobs.hash, sha256Hex(VIDEO(file))))
    .get()!
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 5])
  const key = sha256Hex(bytes)
  const staged = path.join(mkdtempSync(path.join(tmpdir(), 'thumb-')), 'f')
  writeFileSync(staged, bytes)
  await c.blobs.putFile(key, staged)
  c.db
    .insert(blobThumbnails)
    .values({
      blobId: blob.id,
      state: 'ready',
      key,
      size: bytes.length,
      mime: 'image/jpeg',
    })
    .run()
  return { key }
}

function usageOf(c: CaptureContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'))
  return localUsage({
    db: c.db,
    dataDir: dir,
    databasePath: path.join(dir, 'midden.db'),
  })
}
