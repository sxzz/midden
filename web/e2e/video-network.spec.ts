import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from './test'
import { thumb } from './viewer'

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const head = readFileSync(
  fileURLToPath(new URL('fixtures/preview.webm', import.meta.url)),
)
const id = '11111111-1111-4111-8111-111111111111'

/**
 * A server for videos that never finishes an answer: the start of a clip,
 * then nothing, so a request is in flight until the browser gives it up. It
 * counts requests per clip, and those that ended before the answer did.
 */
async function serve() {
  const hits: Record<string, { opened: number; aborted: number }> = {}
  const server: Server = createServer((req, res) => {
    const name = req.url!.split('?', 1)[0]!.slice(1).replace('.webm', '')
    const hit = (hits[name] ??= { opened: 0, aborted: 0 })
    hit.opened++
    res.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': String(head.length + 50_000_000),
      'access-control-allow-origin': '*',
    })
    res.write(head)
    res.on('close', () => {
      if (!res.writableEnded) hit.aborted++
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => server.closeAllConnections() ?? server.close(),
  }
}

async function mock(page: Page, origin: string) {
  const asset = (name: string) => ({
    id: name,
    url: `${origin}/${name}.webm`,
    mime: 'video/webm',
    state: 'ready',
    thumbnail: true,
    thumbnail_url: PIXEL,
  })
  const collection = {
    id,
    text: '几个视频',
    author_name: '作者',
    url: 'https://example.test/videos',
    revision_id: 'r1',
    assets: [asset('a'), asset('b'), asset('c')],
  }
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    return r.fulfill({
      json: path.endsWith('/availability')
        ? { available: true }
        : path.endsWith('/history')
          ? { items: [] }
          : path === `/v1/collections/${id}`
            ? collection
            : path === '/v1/collections'
              ? { items: [collection] }
              : {},
    })
  })
  const requested: string[] = []
  const failed: { url: string; failure: string }[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(origin)) requested.push(request.url())
  })
  page.on('requestfailed', (request) =>
    failed.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? '',
    }),
  )
  return { requested, failed }
}

test('no list, album or post page requests a video, and the viewer only the one shown', async ({
  page,
}) => {
  const media = await serve()
  const seen = await mock(page, media.origin)
  try {
    // Each page shows the posters, three of them, and asks for no video.
    for (const [path, tiles] of [
      ['/', '.row .thumbs img'],
      ['/?layout=album', '.album img'],
      [`/collection/${id}`, '.media img'],
    ] as const) {
      await page.goto(path)
      await expect(page.locator(tiles)).toHaveCount(3)
      await expect(page.locator('video')).toHaveCount(0)
      await page.waitForTimeout(300)
      expect(seen.requested).toEqual([])
    }
    // The viewer loads the video on screen, not its neighbours.
    await page.getByRole('button', { name: '播放视频' }).first().click()
    await expect.poll(() => media.hits.a?.opened).toBe(1)
    await page.waitForTimeout(300)
    expect(media.hits.b).toBeUndefined()
    expect(media.hits.c).toBeUndefined()
    // The neighbours show their posters meanwhile.
    const videos = page.locator('dialog.viewer .stage video')
    await expect(videos.first()).toHaveAttribute('poster', PIXEL)
    const sources = await videos.evaluateAll((all) =>
      all.map((v) => v.getAttribute('src')),
    )
    expect(sources.filter(Boolean)).toEqual([`${media.origin}/a.webm`])
  } finally {
    await media.close()
  }
})

test('leaving a video stops its download, and coming back starts it again', async ({
  page,
}) => {
  const media = await serve()
  const seen = await mock(page, media.origin)
  try {
    await page.goto(`/collection/${id}`)
    await page.getByRole('button', { name: '播放视频' }).first().click()
    const counter = page.locator('dialog.viewer .counter')
    await expect(counter).toHaveText('1 / 3')
    await expect(thumb(page, 2)).toBeEnabled()
    await expect.poll(() => media.hits.a?.opened).toBe(1)
    // Next: the first video's request ends before its answer, and the second
    // one starts.
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText('2 / 3')
    await expect.poll(() => media.hits.a?.aborted).toBe(1)
    await expect.poll(() => media.hits.b?.opened).toBe(1)
    expect(seen.failed).toContainEqual({
      url: `${media.origin}/a.webm`,
      failure: 'net::ERR_ABORTED',
    })
    // Back: the source is restored.
    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText('1 / 3')
    await expect.poll(() => media.hits.a?.opened).toBe(2)
    await expect.poll(() => media.hits.b?.aborted).toBe(1)
    // Closing ends the one on screen; nothing is left downloading.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => media.hits.a?.aborted).toBe(2)
    expect(media.hits.c).toBeUndefined()
    expect(seen.failed.filter((f) => f.failure !== 'net::ERR_ABORTED')).toEqual(
      [],
    )
  } finally {
    await media.close()
  }
})
