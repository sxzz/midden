import { Buffer } from 'node:buffer'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { KeyedLock } from '#blob/locks.ts'
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
  jobs,
  mediaGarbage,
  removedMedia,
  revisions,
} from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { expectCatalogFresh } from '#testing/library.ts'
import { deleteCollection } from './delete.ts'
import { listCollections } from './list.ts'
import { planRemoval, previewRemoval, removeMedia } from './media-removal.ts'
import { restoreMedia } from './media-restore.ts'
import { getCollection, storageUsed } from './read.ts'
import type { FsBlobStore } from '#blob/fs-store.ts'
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
  // Requests for these wait until their promise settles.
  const holds = new Map<string, Promise<void>>()
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
      await holds.get(url)
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
  return { c, clock, media, texts, requests, capture, gate, files, holds }
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
  await (c.blobs as FsBlobStore).putFile(THUMB_KEY, file)
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
    expect(await removeMedia(c, target)).toEqual(preview)
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
    expect(await removeMedia(c, target)).toEqual(preview)
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
    await removeMedia(c, { ids: [one.collectionId] })
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
    await removeMedia(c, { ids: [one.collectionId] })
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
    await removeMedia(c, { ids: [one.collectionId] })
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
    const result = await removeMedia(c, {
      ids: [collectionOf(two.id).collectionId],
    })
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

  test('updates storage totals', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video, photo]
    const one = await capture('1')
    const used = storageUsed(c.db)
    const listed = () =>
      listCollections(c, {}).items.find((i) => i.id === one.collectionId)!
        .storage_bytes!
    const before = listed()
    const { freed_bytes } = await removeMedia(c, { ids: [one.collectionId] })
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
    expect(await removeMedia(c, { ids })).toEqual(preview)
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

  test('written a few items at a time, it does what one write would', async () => {
    const { c, media, capture } = setup()
    const other = { ...photo, url: 'https://m.test/b.jpg', immutableKey: 'b' }
    media['1'] = [video, photo]
    media['2'] = [video, other]
    media['3'] = [video]
    const posts = [await capture('1'), await capture('2'), await capture('3')]
    const ids = posts.slice(0, 2).map((p) => p.collectionId)
    const used = storageUsed(c.db)
    const preview = previewRemoval(c, { ids })
    // Post 3 keeps the video, which posts 1 and 2 share; the two photos are
    // one file, freed once both are gone.
    expect(preview).toEqual({
      media: 3,
      freed_bytes: JPEG.length,
      shared: 1,
    })
    // One item per write: the video of both posts goes in the same one,
    // the photos' file with the second of them.
    const plan = planRemoval(c.db, { ids })
    expect(plan.keys).toHaveLength(3)
    expect(await removeMedia(c, { ids }, { plan, batch: 1 })).toEqual(preview)
    for (const id of ids)
      expect(assetsOf(c, id).every((a) => a.state === 'removed')).toBe(true)
    expect(assetsOf(c, posts[2]!.collectionId)[0]!.state).toBe('ready')
    expect(c.db.select().from(removedMedia).all()).toHaveLength(3)
    expect(storageUsed(c.db)).toBe(used - preview.freed_bytes)
    expectCatalogFresh(c)
  })

  test('what changed between its plan and its write is read again', async () => {
    const { c, media, texts, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const target = { ids: [one.collectionId] }
    const plan = planRemoval(c.db, target)
    expect(plan.effect).toEqual({
      media: 1,
      freed_bytes: VIDEO.length,
      shared: 0,
    })
    // Captured again meanwhile, with a photo now: the video's new asset
    // goes too; the photo, which the owner was not asked about, stays.
    media['1'] = [video, photo]
    texts['1'] = 'edited'
    await capture('1')
    expect(await removeMedia(c, target, { plan })).toEqual(plan.effect)
    const states = c.db
      .select({ kind: assets.kind, state: assets.state })
      .from(assets)
      .all()
      .map((a) => [a.kind, a.state])
    expect(states.toSorted()).toEqual([
      ['image', 'ready'],
      ['video', 'removed'],
      ['video', 'removed'],
    ])
    // Removed meanwhile by another request: nothing is left to write, and
    // the item stays marked once.
    const again = planRemoval(c.db, { ids: [one.collectionId] })
    await removeMedia(c, { ids: [one.collectionId] })
    expect(await removeMedia(c, target, { plan: again })).toEqual(again.effect)
    expect(c.db.select().from(removedMedia).all()).toHaveLength(2)
    expect(
      assetsOf(c, one.collectionId).every((a) => a.state === 'removed'),
    ).toBe(true)
    expectCatalogFresh(c)
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

describe('media restore', () => {
  const downloads = (c: CaptureContext) =>
    c.db.select().from(jobs).where(eq(jobs.type, 'download')).all()
  const garbageKeys = (c: CaptureContext) =>
    c.db
      .select({ key: mediaGarbage.key })
      .from(mediaGarbage)
      .all()
      .map((row) => row.key)
  /** Hold the store's deletes until released; `started` once one waits. */
  function holdDeletes(c: CaptureContext) {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let deleting!: () => void
    const started = new Promise<void>((resolve) => (deleting = resolve))
    const remove = c.blobs.delete.bind(c.blobs)
    c.blobs.delete = async (key) => {
      deleting()
      await held
      return remove(key)
    }
    return { release, started }
  }

  test('within the grace period links the original back, with no download', async () => {
    const { c, clock, media, texts, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    texts['1'] = 'edited'
    await capture('1')
    const id = one.collectionId
    const blob = c.db.select().from(blobs).get()!
    await addThumbnail(c, blob.id)
    const before = { storage: storageOf(c, id), used: storageUsed(c.db) }
    await removeMedia(c, { ids: [id] })
    expect(c.db.select().from(removedMedia).get()).toMatchObject({
      blobHash: blob.hash,
      blobSize: VIDEO.length,
      blobMime: 'video/mp4',
    })
    expect(getCollection(c, id).assets[0]).toMatchObject({
      state: 'removed',
      recoverable: true,
    })
    clock.now += HOUR
    const fetched = requests.length
    const asset = assetsOf(c, id)[0]!
    expect(await restoreMedia(c, id, asset.id)).toEqual({ state: 'ready' })
    expect(downloads(c)).toEqual([])
    await c.queue.drain()
    expect(requests).toHaveLength(fetched)
    // Every capture's asset of it, as the removal took them all.
    const restored = c.db.select().from(blobs).get()!
    expect(restored).toMatchObject({ hash: blob.hash, size: VIDEO.length })
    expect(assetsOf(c, id)).toEqual([
      expect.objectContaining({ state: 'ready', blobId: restored.id }),
      expect.objectContaining({ state: 'ready', blobId: restored.id }),
    ])
    expect(c.db.select().from(blobThumbnails).get()).toMatchObject({
      blobId: restored.id,
      key: THUMB_KEY,
      width: 300,
    })
    expect(c.db.select().from(removedMedia).all()).toEqual([])
    expect(garbageKeys(c)).toEqual([])
    expect(storageOf(c, id)).toBe(before.storage)
    expect(storageUsed(c.db)).toBe(before.used)
    expectCatalogFresh(c)
    const view = getCollection(c, id).assets[0]!
    expect(view).toMatchObject({ state: 'ready', sha256: blob.hash })
    expect(view.thumbnail_url).toContain(THUMB_KEY)
    // Nothing is collected later.
    clock.now += 25 * HOUR
    expect(await collectMedia(c)).toBe(0)
    expect(await c.blobs.stat(blob.hash)).toBe(VIDEO.length)
  })

  test('links back a blob another post still uses', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video]
    media['2'] = [video]
    const one = await capture('1')
    await capture('2')
    const blob = c.db.select().from(blobs).get()!
    await removeMedia(c, { ids: [one.collectionId] })
    const asset = assetsOf(c, one.collectionId)[0]!
    expect(await restoreMedia(c, one.collectionId, asset.id)).toEqual({
      state: 'ready',
    })
    expect(assetsOf(c, one.collectionId)[0]).toMatchObject({
      state: 'ready',
      blobId: blob.id,
    })
    expect(downloads(c)).toEqual([])
  })

  test('a file the worker is collecting is downloaded again, not linked', async () => {
    const { c, clock, media, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    const hash = c.db.select().from(blobs).get()!.hash
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    // The worker's collection is deleting the file when the web process,
    // which shares no lock with it, restores the media.
    const { release, started } = holdDeletes(c)
    const collected = collectMedia(c)
    await started
    const web = { ...c, mediaLocks: new KeyedLock() }
    const asset = assetsOf(c, id)[0]!
    // Still there, but claimed: no link to a file about to go.
    expect(await c.blobs.stat(hash)).toBe(VIDEO.length)
    const result = await restoreMedia(web, id, asset.id)
    expect(result).toEqual({ state: 'downloading', job: expect.any(Number) })
    release()
    expect(await collected).toBe(1)
    await c.queue.drain()
    expect(requests.filter((url) => url === video.url)).toHaveLength(2)
    const blob = c.db.select().from(blobs).get()!
    expect(blob.hash).toBe(hash)
    expect(await c.blobs.stat(hash)).toBe(VIDEO.length)
    expect(assetsOf(c, id)[0]).toMatchObject({
      state: 'ready',
      blobId: blob.id,
    })
  })

  test('in one process, a restore waits for the collection under way', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    const hash = c.db.select().from(blobs).get()!.hash
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    const { release, started } = holdDeletes(c)
    const collected = collectMedia(c)
    await started
    const restored = restoreMedia(c, id, assetsOf(c, id)[0]!.id)
    release()
    expect(await collected).toBe(1)
    expect((await restored).state).toBe('downloading')
    await c.queue.drain()
    expect(await c.blobs.stat(hash)).toBe(VIDEO.length)
    expect(assetsOf(c, id)[0]!.state).toBe('ready')
  })

  test('a restore first keeps the file from the collection after it', async () => {
    const { c, clock, media, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    const hash = c.db.select().from(blobs).get()!.hash
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    const restored = restoreMedia(c, id, assetsOf(c, id)[0]!.id)
    const collected = collectMedia(c)
    expect(await restored).toEqual({ state: 'ready' })
    expect(await collected).toBe(0)
    expect(await c.blobs.stat(hash)).toBe(VIDEO.length)
    expect(garbageKeys(c)).toEqual([])
  })

  test('after the grace period downloads the original again, the thumbnail standing in', async () => {
    const { c, clock, media, texts, requests, capture, holds } = setup()
    media['1'] = [video]
    const one = await capture('1')
    texts['1'] = 'edited'
    const two = await capture('1')
    const id = one.collectionId
    const blob = c.db.select().from(blobs).get()!
    await addThumbnail(c, blob.id)
    const before = storageOf(c, id)
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    expect(await collectMedia(c)).toBe(1)
    expect(await c.blobs.stat(blob.hash)).toBeUndefined()
    expect(getCollection(c, id).assets[0]!.recoverable).toBeUndefined()

    let release!: () => void
    holds.set(video.url, new Promise((resolve) => (release = resolve)))
    const fetched = requests.length
    const [first, second] = assetsOf(c, id)
    const result = await restoreMedia(c, id, second!.id)
    expect(result).toEqual({ state: 'downloading', job: expect.any(Number) })
    const job = downloads(c)[0]!
    expect(job).toMatchObject({ id: (result as { job: number }).job })
    expect(job.ref).toBe(second!.id)
    // The owner's rank.
    expect(job.priority).toBe(0)
    // Asked again meanwhile, by another capture's asset: the same job.
    expect(await restoreMedia(c, id, first!.id)).toEqual(result)
    expect(downloads(c)).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The kept thumbnail shows it while it downloads, and is no garbage.
    const view = getCollection(c, id).assets[0]!
    expect(view).toMatchObject({ state: 'pending', restoring: true })
    expect(view.thumbnail_url).toContain(THUMB_KEY)
    expect(garbageKeys(c)).not.toContain(THUMB_KEY)
    expect(c.db.select().from(removedMedia).get()).toMatchObject({
      restore: 'downloading',
      thumbnailKey: THUMB_KEY,
    })
    release()
    await c.queue.drain()
    expect(requests.slice(fetched)).toEqual([video.url])
    const restored = c.db.select().from(blobs).get()!
    expect(restored.hash).toBe(blob.hash)
    expect(assetsOf(c, id)).toEqual([
      expect.objectContaining({ state: 'ready', blobId: restored.id }),
      expect.objectContaining({ state: 'ready', blobId: restored.id }),
    ])
    expect(c.db.select().from(removedMedia).all()).toEqual([])
    // The same thumbnail, now the new blob's: kept, not fetched.
    expect(c.db.select().from(blobThumbnails).get()).toMatchObject({
      blobId: restored.id,
      key: THUMB_KEY,
    })
    expect(garbageKeys(c)).not.toContain(THUMB_KEY)
    expect(storageOf(c, id)).toBe(before)
    expect(getCollection(c, id).assets[0]!.restoring).toBeUndefined()
    // The same bytes: the next capture makes no new revision.
    expect((await capture('1')).revisionId).toBe(two.revisionId)
  })

  test('the kept thumbnail is garbage when the blob has one of its own', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video]
    media['2'] = [video]
    const one = await capture('1')
    await capture('2')
    const blob = c.db.select().from(blobs).get()!
    // The mark kept another thumbnail than the one the blob has now.
    const kept = sha256Hex(Buffer.from('kept'))
    await removeMedia(c, { ids: [one.collectionId] })
    c.db
      .update(removedMedia)
      .set({ thumbnailKey: kept, thumbnailMime: 'image/jpeg' })
      .run()
    await addThumbnail(c, blob.id)
    const asset = assetsOf(c, one.collectionId)[0]!
    expect((await restoreMedia(c, one.collectionId, asset.id)).state).toBe(
      'ready',
    )
    expect(c.db.select().from(blobThumbnails).get()!.key).toBe(THUMB_KEY)
    expect(garbageKeys(c)).toEqual([kept])
  })

  test('a download refused for good keeps the thumbnail and says why', async () => {
    const { c, clock, media, requests, capture, files } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    await addThumbnail(c, c.db.select().from(blobs).get()!.id)
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    await collectMedia(c)
    delete files[video.url]
    const asset = assetsOf(c, id)[0]!
    expect((await restoreMedia(c, id, asset.id)).state).toBe('downloading')
    await c.queue.drain()
    // Tried once: a refusal is final, and nothing tries again by itself.
    expect(requests.filter((url) => url === video.url)).toHaveLength(2)
    expect(downloads(c)).toEqual([])
    expect(assetsOf(c, id)[0]).toMatchObject({ state: 'removed', blobId: null })
    const view = getCollection(c, id).assets[0]!
    expect(view).toMatchObject({
      state: 'removed',
      restore_error: '媒体服务器拒绝了请求',
    })
    expect(view.restoring).toBeUndefined()
    expect(view.thumbnail_url).toContain(THUMB_KEY)
    expect(
      c.db.select().from(captures).where(eq(captures.id, one.id)).get(),
    ).toMatchObject({ state: 'complete' })
    // The placeholder outlives collection, and captures skip the media
    // again rather than fail on it.
    clock.now += 25 * HOUR
    await collectMedia(c)
    expect(await c.blobs.stat(THUMB_KEY)).toBe(THUMB.length)
    const fetched = requests.length
    const again = await capture('1')
    expect(again.state).toBe('complete')
    expect(requests).toHaveLength(fetched)
  })

  test('an old banner downloads its own address, not the current one', async () => {
    const { c, clock, media, requests, capture, files } = setup()
    const banner = (n: number): Media => ({
      url: `https://m.test/banner-${n}.jpg`,
      kind: 'image',
      purpose: 'banner',
      immutableKey: `x:banner:${n}`,
    })
    files['https://m.test/banner-1.jpg'] = JPEG
    files['https://m.test/banner-2.jpg'] = THUMB
    media['1'] = [banner(1)]
    const one = await capture('1')
    const id = one.collectionId
    // The account changed its banner since.
    media['1'] = [banner(2)]
    await capture('1')
    const old = c.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.captureId, one.id))
      .get()!
    await removeMedia(c, { collection: id, asset: old.id })
    clock.now += 25 * HOUR
    await collectMedia(c)
    const fetched = requests.length
    expect((await restoreMedia(c, id, old.id)).state).toBe('downloading')
    await c.queue.drain()
    expect(requests.slice(fetched)).toEqual(['https://m.test/banner-1.jpg'])
    const restored = c.db
      .select({ state: assets.state, hash: blobs.hash })
      .from(assets)
      .innerJoin(blobs, eq(blobs.id, assets.blobId))
      .where(eq(assets.id, old.id))
      .get()
    expect(restored).toEqual({ state: 'ready', hash: sha256Hex(JPEG) })
  })

  test('a mark made before the original was kept downloads it again', async () => {
    const { c, media, requests, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    await removeMedia(c, { ids: [id] })
    c.db
      .update(removedMedia)
      .set({ blobHash: null, blobSize: null, blobMime: null })
      .run()
    expect(getCollection(c, id).assets[0]!.recoverable).toBeUndefined()
    const fetched = requests.length
    const asset = assetsOf(c, id)[0]!
    expect((await restoreMedia(c, id, asset.id)).state).toBe('downloading')
    await c.queue.drain()
    expect(requests.slice(fetched)).toEqual([video.url])
    expect(assetsOf(c, id)[0]!.state).toBe('ready')
    expect(c.db.select().from(removedMedia).all()).toEqual([])
  })

  test('media an earlier restore left to the next capture downloads now', async () => {
    const { c, media, capture } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    await removeMedia(c, { ids: [id] })
    // Restores used to clear the mark only.
    c.db.delete(removedMedia).run()
    const asset = assetsOf(c, id)[0]!
    expect(getCollection(c, id).assets[0]!.download_again).toBe(true)
    expect((await restoreMedia(c, id, asset.id)).state).toBe('downloading')
    await c.queue.drain()
    expect(assetsOf(c, id)[0]!.state).toBe('ready')
    expect(c.db.select().from(removedMedia).all()).toEqual([])
  })

  test('removed again while it downloads, it is removed plainly', async () => {
    const { c, clock, media, capture, holds } = setup()
    media['1'] = [video]
    const one = await capture('1')
    const id = one.collectionId
    await removeMedia(c, { ids: [id] })
    clock.now += 25 * HOUR
    await collectMedia(c)
    let release!: () => void
    holds.set(video.url, new Promise((resolve) => (release = resolve)))
    await restoreMedia(c, id, assetsOf(c, id)[0]!.id)
    await removeMedia(c, { ids: [id] })
    expect(c.db.select().from(removedMedia).get()).toMatchObject({
      restore: null,
    })
    release()
    await c.queue.drain()
    expect(assetsOf(c, id)[0]!.state).toBe('removed')
    expect(c.db.select().from(blobs).all()).toEqual([])
  })
})
