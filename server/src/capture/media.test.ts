import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  assets,
  blobs,
  blobThumbnails,
  captures,
  revisions,
} from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { captureHandlers } from './handlers.ts'
import { submit } from './submit.ts'
import { detectThumbnailer } from './thumbnail.ts'
import type { Resource } from '#platforms/protocol.ts'
import type { CaptureContext, Thumbnailer } from './context.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])
const GIF = Buffer.from('GIF89a....')

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(
  resources: () => Partial<Resource>[],
  files: Record<string, Buffer | number>,
  thumbnailer?: Thumbnailer,
) {
  const requests: string[] = []
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: `post ${req.externalId}`,
          resources: resources().map((r) => ({
            kind: 'image',
            immutableKey: '',
            altText: '',
            sensitive: false,
            purpose: '',
            url: '',
            ...r,
          })),
          graph: postGraph(req.externalId, { text: 'x' }, undefined, {
            resourceIndices: resources().map((_, i) => i),
          }),
        }),
      }),
    ],
    handlers: captureHandlers,
    thumbnailer,
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      const file = files[url]
      if (typeof file === 'number') return new Response(null, { status: file })
      return new Response(file ?? null, { status: file ? 200 : 404 })
    },
  })
  ctx.queue.start()
  return { ctx, requests }
}

async function capture(c: CaptureContext, id: string) {
  const job = submit(c, { url: `https://fake.test/p/${id}` })
  await c.queue.drain()
  return c.db
    .select()
    .from(captures)
    .all()
    .find((row) => row.id === job.id)!
}

describe('media', () => {
  test('downloads, stores and finalizes media', async () => {
    const { ctx } = setup(() => [{ url: 'https://m.test/a.jpg' }], {
      'https://m.test/a.jpg': JPEG,
    })
    const done = await capture(ctx, '1')
    expect(done.state).toBe('complete')
    const blob = ctx.db.select().from(blobs).get()!
    expect(blob).toMatchObject({ size: JPEG.length, mime: 'image/jpeg' })
    expect(await ctx.blobs.stat(blob.hash)).toBe(JPEG.length)
    expect(ctx.db.select().from(assets).get()).toMatchObject({
      state: 'ready',
      blobId: blob.id,
    })
    expect(ctx.db.select().from(revisions).all()).toHaveLength(1)
  })

  test('an immutable key is downloaded once; identical bytes stored once', async () => {
    let key = 'photo-1'
    const { ctx, requests } = setup(
      () => [{ url: 'https://m.test/a.jpg', immutableKey: key }],
      { 'https://m.test/a.jpg': JPEG },
    )
    await capture(ctx, '1')
    await capture(ctx, '2')
    expect(requests).toHaveLength(1)
    key = 'photo-1:other-rendition'
    await capture(ctx, '3')
    expect(requests).toHaveLength(2)
    expect(ctx.db.select().from(blobs).all()).toHaveLength(1)
  })

  test('media stored before under its immutable key needs no download job', async () => {
    const { ctx } = setup(
      () => [{ url: 'https://m.test/a.jpg', immutableKey: 'photo-1' }],
      { 'https://m.test/a.jpg': JPEG },
    )
    await capture(ctx, '1')
    const enqueue = vi.spyOn(ctx.queue, 'enqueue')
    const again = await capture(ctx, '2')
    expect(again.state).toBe('complete')
    expect(enqueue.mock.calls.map((call) => call[1])).not.toContain('download')
    const [first, second] = ctx.db
      .select({ state: assets.state, blobId: assets.blobId })
      .from(assets)
      .all()
    expect(second).toEqual({ state: 'ready', blobId: first!.blobId })
  })

  test('rejected and unsupported media leave a partial capture', async () => {
    const { ctx } = setup(
      () => [
        { url: 'https://m.test/a.gif' },
        { url: 'https://m.test/missing.jpg' },
        { url: 'https://m.test/b.jpg' },
      ],
      { 'https://m.test/a.gif': GIF, 'https://m.test/b.jpg': JPEG2 },
    )
    const done = await capture(ctx, '1')
    expect(done.state).toBe('partial')
    expect(
      ctx.db
        .select({ state: assets.state, error: assets.error })
        .from(assets)
        .orderBy(assets.position)
        .all(),
    ).toEqual([
      { state: 'failed', error: '不支持的媒体格式' },
      { state: 'failed', error: '媒体服务器拒绝了请求' },
      { state: 'ready', error: '' },
    ])
  })

  test('only purposed media and no text is still nothing saved', async () => {
    const { ctx } = setup(() => [], {})
    // A graph is content, so this capture completes.
    expect((await capture(ctx, '1')).state).toBe('complete')
  })

  const ffmpeg = process.env.FFMPEG
  test.runIf(ffmpeg)('renders a bounded thumbnail per blob', async () => {
    const thumbnailer = (await detectThumbnailer(ffmpeg))!
    const dir = mkdtempSync(path.join(tmpdir(), 'midden-frame-'))
    const frame = path.join(dir, 'frame.png')
    execFileSync(ffmpeg!, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=2000x1000',
      '-frames:v',
      '1',
      frame,
    ])
    const { ctx } = setup(
      () => [{ url: 'https://m.test/a.png' }, { url: 'https://m.test/b.png' }],
      {
        'https://m.test/a.png': readFileSync(frame),
        'https://m.test/b.png': readFileSync(frame),
      },
      thumbnailer,
    )
    await capture(ctx, '1')
    const thumbnails = ctx.db.select().from(blobThumbnails).all()
    expect(thumbnails).toHaveLength(1)
    expect(thumbnails[0]).toMatchObject({
      state: 'ready',
      width: 800,
      height: 400,
    })
    const out = path.join(dir, 'thumb')
    const { pipeline } = await import('node:stream/promises')
    const { createWriteStream } = await import('node:fs')
    await pipeline(
      await ctx.blobs.read(thumbnails[0]!.key!),
      createWriteStream(out),
    )
    const probe = execFileSync(
      path.join(path.dirname(ffmpeg!), 'ffprobe'),
      [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        out,
      ],
      { encoding: 'utf8' },
    )
    expect(probe.trim()).toBe('800,400')
  })
})
