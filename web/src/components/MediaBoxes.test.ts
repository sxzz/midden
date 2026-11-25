import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { asset as build } from '../testing/api'
import MediaGallery from './MediaGallery.vue'
import MediaThumbs from './MediaThumbs.vue'
import type { Asset } from '../api'

// jsdom does no layout, so these check the box each item is given: its
// reserved aspect ratio and how the row is divided.
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})
function mount(
  component: typeof MediaGallery | typeof MediaThumbs,
  assets: Asset[],
) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(component, { assets }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const photo = (
  id: string,
  size?: [number, number],
  extra: Partial<Asset> = {},
) =>
  build({
    id,
    mime: 'image/png',
    url: `/media/${id}`,
    ...(size ? { width: size[0], height: size[1] } : {}),
    ...extra,
  })
const rows = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('.row')].map((row) => ({
    ratio: Number(row.style.getPropertyValue('--row-ratio')),
    columns: row
      .getAttribute('style')
      ?.match(/grid-template-columns: ([^;]+)/)?.[1],
    cells: row.querySelectorAll('.frame').length,
  }))
const fits = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('.media-preview')].map((preview) =>
    preview.style.getPropertyValue('--media-fit'),
  )

describe('detail gallery boxes', () => {
  it('sizes a wide single image by its own shape, not a tall fixed box', () => {
    const el = mount(MediaGallery, [photo('a', [1200, 200])])
    expect(rows(el)).toEqual([
      { ratio: 6, columns: 'minmax(0px, 6fr)', cells: 1 },
    ])
    // Contained, never cropped, whatever the box.
    expect(fits(el)).toEqual(['contain'])
  })

  it('gives a square and a landscape their own shapes', () => {
    expect(rows(mount(MediaGallery, [photo('a', [500, 500])]))[0]!.ratio).toBe(
      1,
    )
    unmount()
    expect(
      rows(mount(MediaGallery, [photo('a', [1600, 900])]))[0]!.ratio,
    ).toBeCloseTo(16 / 9)
  })

  it('stops tall images at 3:4', () => {
    const el = mount(MediaGallery, [photo('a', [900, 1600])])
    expect(rows(el)[0]!.ratio).toBe(0.75)
  })

  it('stops extreme panoramas at 6:1', () => {
    const el = mount(MediaGallery, [photo('a', [6000, 300])])
    expect(rows(el)[0]!.ratio).toBe(6)
  })

  it('reserves 4:3 where the size is unknown', () => {
    const el = mount(MediaGallery, [photo('a')])
    expect(rows(el)[0]!.ratio).toBeCloseTo(4 / 3)
  })

  it('learns the shape from the loaded image when the server had none', async () => {
    const el = mount(MediaGallery, [photo('a')])
    const img = el.querySelector('img')!
    Object.defineProperties(img, {
      naturalWidth: { value: 800 },
      naturalHeight: { value: 200 },
    })
    img.dispatchEvent(new Event('load'))
    await nextTick()
    expect(rows(el)[0]!.ratio).toBe(4)
  })

  it('shows two ordinary images side by side at one height', () => {
    const el = mount(MediaGallery, [
      photo('a', [1000, 1000]),
      photo('b', [2000, 1000]),
    ])
    expect(rows(el)).toEqual([
      { ratio: 3, columns: 'minmax(0px, 1fr) minmax(0px, 2fr)', cells: 2 },
    ])
  })

  it('stacks two wide images, each as tall as its own shape', () => {
    const el = mount(MediaGallery, [
      photo('a', [1200, 200]),
      photo('b', [1200, 240]),
    ])
    expect(rows(el).map((row) => [row.ratio, row.cells])).toEqual([
      [6, 1],
      [5, 1],
    ])
  })

  it('divides three and four images into rows by the same rule', () => {
    const three = mount(MediaGallery, [
      photo('a', [1, 1]),
      photo('b', [1, 1]),
      photo('c', [1200, 400]),
    ])
    expect(rows(three).map((row) => [row.ratio, row.cells])).toEqual([
      [2, 2],
      [3, 1],
    ])
    unmount()
    const four = mount(MediaGallery, [
      photo('a', [1, 1]),
      photo('b', [1, 1]),
      photo('c', [1, 1]),
      photo('d', [1, 1]),
    ])
    expect(rows(four).map((row) => row.cells)).toEqual([2, 2])
  })

  it('boxes a video by its poster and keeps notices out of the boxes', () => {
    const el = mount(MediaGallery, [
      photo('v', [1280, 720], { mime: 'video/mp4', thumbnail: true }),
      photo('f', undefined, {
        state: 'failed',
        mime: undefined,
        url: undefined,
      }),
    ])
    const [video, notice] = rows(el)
    expect(video!.ratio).toBeCloseTo(16 / 9)
    expect(notice!.ratio).toBe(0)
    expect(el.querySelector('.play')).not.toBeNull()
  })

  it('keeps a removed item, with its label, in a box tall enough for it', () => {
    const el = mount(MediaGallery, [
      photo('r', [1200, 200], {
        state: 'removed',
        thumbnail: true,
        thumbnail_url: '/media/thumb',
        kind: 'image',
      }),
    ])
    expect(rows(el)[0]!.ratio).toBe(3)
    expect(el.querySelector('.removed-label')).not.toBeNull()
  })
})

describe('list thumbnails', () => {
  const style = (el: HTMLElement) =>
    el
      .querySelector<HTMLElement>('.thumbs-group')!
      .style.getPropertyValue('--preview-ratio')

  it('boxes a single wide image by its shape instead of a 2:1 cap', () => {
    const el = mount(MediaThumbs, [photo('a', [1200, 200])])
    expect(Number(style(el))).toBe(6)
    expect(el.querySelector('.thumbs.shaped')).not.toBeNull()
  })

  it('holds a tall single image to 3:4', () => {
    expect(Number(style(mount(MediaThumbs, [photo('a', [900, 1600])])))).toBe(
      0.75,
    )
  })

  it('puts a pair side by side, or stacks wide ones', () => {
    expect(
      Number(
        style(mount(MediaThumbs, [photo('a', [1, 1]), photo('b', [2, 1])])),
      ),
    ).toBe(3)
    unmount()
    const wide = mount(MediaThumbs, [
      photo('a', [1200, 200]),
      photo('b', [1200, 200]),
    ])
    // Two 6:1 rows one above the other.
    expect(Number(style(wide))).toBe(3)
  })

  it('keeps the fixed grid from three images', () => {
    const el = mount(MediaThumbs, [
      photo('a', [1200, 200]),
      photo('b', [1200, 200]),
      photo('c', [1200, 200]),
    ])
    expect(el.querySelector('.thumbs.shaped')).toBeNull()
    expect(Number(style(el))).toBe(2)
  })
})
