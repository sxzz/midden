import { Buffer } from 'node:buffer'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { sha256Hex } from '#capture/json.ts'
import { collectCollections, collectMedia } from '#capture/maintenance.ts'
import { mediaKey } from '#capture/media-key.ts'
import { submit } from '#capture/submit.ts'
import {
  assets,
  blobs,
  blobThumbnails,
  captures,
  catalog,
  mediaGarbage,
  removedMedia,
  revisions,
} from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { expectCatalogFresh } from '#testing/library.ts'
import { deleteCollection } from './delete.ts'
import { listCollections } from './list.ts'
import { previewRemoval, removeMedia, restoreMedia } from './media-removal.ts'
import { getCollection, storageUsed } from './read.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Resource } from '#platforms/protocol.ts'

const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(200, 7),
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 5])
const THUMB_KEY = sha256Hex(THUMB)
const HOUR = 60 * 60_000

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

type Media = Partial<Resource> & { url: string }

/**
 * Posts whose media each test sets per post id; every request for a file
 * is counted, so a skipped download shows as none.
 */
function setup() {
  const clock = { now: Date.now() }
  const media: Record<string, Media[]> = {}
  const texts: Record<string, string> = {}
  const requests: string[] = []
  const gate = { open: () => {} }
  const opened = new Promise<void>((resolve) => (gate.open = resolve))
  const files: Record<string, Buffer> = {
    'https://m.test/v.mp4': VIDEO,
    'https://m.test/a.jpg': JPEG,
  }
  const c = testContext({
    now: () => clock.now,
    platforms: [
      fakePlatform({
        current: (req) => {
          const list = media[req.externalId] ?? []
          return {
            text: texts[req.externalId] ?? `post ${req.externalId}`,
            resources: list.map((r) => ({
              kind: 'image',
              immutableKey: '',
              altText: '',
              sensitive: false,
              purpose: '',
              ...r,
            })),
            graph: postGraph(req.externalId, {}, undefined, {
              resourceIndices: list.map((_, i) => i),
            }),
          }
        },
      }),
    ],
    handlers: captureHandlers,
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://m.test/slow.mp4') {
        await opened
        return new Response(VIDEO)
      }
      const file = files[url]
      return new Response(file ?? null, { status: file ? 200 : 404 })
    },
  })
  ctx = c
  c.queue.start()
  const saved = new Map<string, string>()
  // A post captured before is refreshed, as 更新 does.
  const capture = async (id: string) => {
    const refreshId = saved.get(id)
    const job = submit(
      c,
      refreshId ? { refreshId } : { url: `https://fake.test/p/${id}` },
    )
    await c.queue.drain()
    const done = c.db
      .select()
      .from(captures)
      .where(eq(captures.id, job.id))
      .get()!
    saved.set(id, done.collectionId)
    return done
  }
  return { c, clock, media, texts, requests, capture, gate }
}

const video: Media = {
  url: 'https://m.test/v.mp4',
  kind: 'video',
  immutableKey: 'x:media:video:42',
}
const photo: Media = {
  url: 'https://m.test/a.jpg',
  kind: 'image',
  immutableKey: 'x:media:image:43',
}

function assetsOf(c: CaptureContext, collectionId: string) {
  return c.db
    .select({ id: assets.id, state: assets.state, blobId: assets.blobId })
    .from(assets)
    .innerJoin(captures, eq(captures.id, assets.captureId))
    .where(eq(captures.collectionId, collectionId))
    .all()
}

const storageOf = (c: CaptureContext, id: string) =>
  c.db.select().from(catalog).where(eq(catalog.collectionId, id)).get()!
    .storageBytes

/** Give the blob a stored thumbnail, as the thumbnailer would. */
async function addThumbnail(c: CaptureContext, blobId: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'thumb-')), 'f')
  writeFileSync(file, THUMB)
  await c.blobs.putFile(THUMB_KEY, file)
  c.db
    .insert(blobThumbnails)
    .values({
      blobId,
      state: 'ready',
      key: THUMB_KEY,
      size: THUMB.length,
      mime: 'image/jpeg',
      width: 300,
      height: 100,
    })
    .run()
}

describe('media removal', () => {
  test('removes the media from every revision and capture, as previewed', async () => {
    const { c, media, texts, capture } = setup()
    media['1'] = [video, photo]
    const first = await capture('1')
    texts['1'] = 'edited'
    await capture('1')
    const id = first.collectionId
    expect(c.db.select().from(revisions).all()).toHaveLength(2)
    const before = storageOf(c, id)
    const target = { collection: id, asset: assetsOf(c, id)[0]!.id }
    const preview = previewRemoval(c, target)
    expect(preview).toEqual({
      media: 1,
      freed_bytes: VIDEO.length,
      shared: 0,
    })
    expect(removeMedia(c, target)).toEqual(preview)
    const states = assetsOf(c, id)
    expect(states).toHaveLength(4)
    // Both captures' video went; both photos stay.
    expect(states.filter((a) => a.state === 'removed')).toHaveLength(2)
    expect(
      states.filter((a) => a.state === 'removed').every((a) => !a.blobId),
    ).toBe(true)
    expect(states.filter((a) => a.state === 'ready')).toHaveLength(2)
    const [blob] = c.db.select().from(blobs).all()
    expect(c.db.select().from(blobs).all()).toHaveLength(1)
    expect(blob!.size).toBe(JPEG.length)
    // Storage drops by exactly what the preview said.
    expect(storageOf(c, id)).toBe(before - preview.freed_bytes)
    expectCatalogFresh(c)
  })

  test('a blob another post uses stays until that one goes too', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [video]
    media['2'] = [video]
    const one = await capture('1')
    const two = await capture('2')
    const blobId = c.db.select().from(blobs).get()!.id
    const target = {
      collection: one.collectionId,
      asset: assetsOf(c, one.collectionId)[0]!.id,
    }
    const preview = previewRemoval(c, target)
    expect(preview).toEqual({ media: 1, freed_bytes: 0, shared: 1 })
    expect(removeMedia(c, target)).toEqual(preview)
    expect(c.db.select().from(blobs).all()).toHaveLength(1)
    expect(assetsOf(c, two.collectionId)[0]).toMatchObject({
      state: 'ready',
      blobId,
    })
    expect(c.db.select().from(mediaGarbage).all()).toEqual([])

    deleteCollection(c.db, two.collectionId)
    await collectCollections(c)
    expect(c.db.select().from(blobs).all()).toEqual([])
    const hash = c.db.select().from(mediaGarbage).get()!.key
    clock.now += 25 * HOUR
    expect(await collectMedia(c)).toBe(1)
    expect(await c.blobs.stat(hash)).toBeUndefined()
  })

  test('keeps the thumbnail while the original is collected', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const blob = c.db.select().from(blobs).get()!
    await addThumbnail(c, blob.id)
    removeMedia(c, { ids: [one.collectionId] })
    expect(c.db.select().from(removedMedia).get()).toMatchObject({
      kind: 'video',
      thumbnailKey: THUMB_KEY,
      thumbnailMime: 'image/jpeg',
      thumbnailWidth: 300,
      thumbnailHeight: 100,
    })
    expect(c.db.select().from(blobThumbnails).all()).toEqual([])
    clock.now += 25 * HOUR
    await collectMedia(c)
    expect(await c.blobs.stat(blob.hash)).toBeUndefined()
    expect(await c.blobs.stat(THUMB_KEY)).toBe(THUMB.length)
    expect(c.db.select().from(mediaGarbage).all()).toEqual([])

    const view = getCollection(c, one.collectionId)
    expect(view.assets[0]).toMatchObject({
      state: 'removed',
      kind: 'video',
      thumbnail: true,
      width: 300,
      height: 100,
      size: 0,
    })
    expect(view.assets[0]!.thumbnail_url).toContain(THUMB_KEY)
    expect(view.assets[0]!.url).toBeUndefined()
    expect(view.assets[0]!.download_again).toBeUndefined()
  })

  test('a later capture of the post skips the removed media', async () => {
    const { c, media, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    removeMedia(c, { ids: [one.collectionId] })
    const fetched = requests.length
    const again = await capture('1')
    expect(requests).toHaveLength(fetched)
    // Nothing is missing, and nothing changed: no new revision.
    expect(again.state).toBe('complete')
    expect(again.revisionId).toBe(one.revisionId)
    expect(assetsOf(c, one.collectionId).map((a) => a.state)).toEqual([
      'removed',
      'removed',
    ])
  })

  test('another post with the same media skips it too, shown as removed', async () => {
    const { c, media, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    await addThumbnail(c, c.db.select().from(blobs).get()!.id)
    removeMedia(c, { ids: [one.collectionId] })
    const fetched = requests.length
    // A quote listing the same video under another address.
    media['2'] = [{ ...video, url: 'https://m.test/other.mp4' }, photo]
    const two = await capture('2')
    expect(requests).toEqual([
      ...requests.slice(0, fetched),
      'https://m.test/a.jpg',
    ])
    expect(two.state).toBe('complete')
    const view = getCollection(c, two.collectionId)
    expect(view.assets.map((a) => a.state)).toEqual(['removed', 'ready'])
    expect(view.assets[0]!.thumbnail_url).toContain(THUMB_KEY)
  })

  test('downloads under way or queued when the media is removed', async () => {
    const { c, media, gate, requests } = setup()
    const slow = { ...video, url: 'https://m.test/slow.mp4' }
    media['2'] = [slow]
    media['3'] = [slow]
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const two = submit(c, { url: 'https://fake.test/p/2' })
    const drained = c.queue.drain()
    await until(() => requests.includes(slow.url))
    // Post 2's download is in flight; post 3's waits for the same media.
    const three = submit(c, { url: 'https://fake.test/p/3' })
    const drainedToo = c.queue.drain()
    await until(() => c.db.select().from(assets).all().length === 2)
    const collectionOf = (id: string) =>
      c.db.select().from(captures).where(eq(captures.id, id)).get()!
    const result = removeMedia(c, { ids: [collectionOf(two.id).collectionId] })
    expect(result).toEqual({ media: 1, freed_bytes: 0, shared: 0 })
    gate.open()
    await Promise.all([drained, drainedToo])
    for (const job of [two, three]) {
      const done = collectionOf(job.id)
      expect(done.state).toBe('complete')
      expect(assetsOf(c, done.collectionId)[0]!.state).toBe('removed')
    }
    expect(requests.filter((url) => url === slow.url)).toHaveLength(1)
    // The file that arrived after the removal is garbage, not kept.
    expect(c.db.select().from(blobs).all()).toEqual([])
    expect(c.db.select().from(mediaGarbage).all()).toHaveLength(1)
  })

  test('restoring lets the next capture download it again', async () => {
    const { c, media, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    await addThumbnail(c, c.db.select().from(blobs).get()!.id)
    removeMedia(c, { ids: [one.collectionId] })
    const removed = assetsOf(c, one.collectionId)[0]!
    restoreMedia(c, one.collectionId, removed.id)
    expect(c.db.select().from(removedMedia).all()).toEqual([])
    expect(c.db.select().from(mediaGarbage).all()).toContainEqual(
      expect.objectContaining({ key: THUMB_KEY }),
    )
    expect(getCollection(c, one.collectionId).assets[0]).toMatchObject({
      state: 'removed',
      download_again: true,
    })
    const fetched = requests.length
    const again = await capture('1')
    expect(requests).toHaveLength(fetched + 1)
    expect(again.revisionId).not.toBe(one.revisionId)
    expect(getCollection(c, one.collectionId).assets[0]!.state).toBe('ready')
  })

  test('updates storage totals', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video, photo]
    const one = await capture('1')
    const used = storageUsed(c.db)
    const listed = () =>
      listCollections(c, {}).items.find((i) => i.id === one.collectionId)!
        .storage_bytes!
    const before = listed()
    const { freed_bytes } = removeMedia(c, { ids: [one.collectionId] })
    expect(freed_bytes).toBe(VIDEO.length + JPEG.length)
    expect(storageUsed(c.db)).toBe(used - freed_bytes)
    expect(listed()).toBe(before - freed_bytes)
  })

  test('a batch removes the media of every selected post', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video]
    media['2'] = [photo]
    media['3'] = [video]
    const one = await capture('1')
    const two = await capture('2')
    const three = await capture('3')
    const ids = [one.collectionId, two.collectionId]
    const preview = previewRemoval(c, { ids })
    // The video is shared with post 3, so only the photo is freed.
    expect(preview).toEqual({ media: 2, freed_bytes: JPEG.length, shared: 1 })
    expect(removeMedia(c, { ids })).toEqual(preview)
    for (const id of ids)
      expect(assetsOf(c, id).every((a) => a.state === 'removed')).toBe(true)
    expect(assetsOf(c, three.collectionId)[0]!.state).toBe('ready')
    expect(c.db.select().from(removedMedia).all()).toHaveLength(2)
    // Applying again finds nothing left to remove.
    expect(previewRemoval(c, { ids })).toEqual({
      media: 0,
      freed_bytes: 0,
      shared: 0,
    })
  })

  test('the media key ignores the rendition Instagram picked', () => {
    const key = (immutableKey: string) =>
      mediaKey('instagram', { immutableKey, url: 'https://cdn.test/x' })
    expect(key('instagram:media:9:video:720x1280:1000')).toBe(
      key('instagram:media:9:video:1080x1920:3000'),
    )
    expect(key('instagram:media:9:video:720x1280:1000')).not.toBe(
      key('instagram:media:8:video:720x1280:1000'),
    )
    expect(mediaKey('x', { immutableKey: '', url: 'https://a.test/b' })).toBe(
      'url:https://a.test/b',
    )
  })
})
