import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import MediaGallery from './MediaGallery.vue'
import MediaThumbs from './MediaThumbs.vue'
import type { Asset } from '../api'

const asset = (id: string, sensitive: boolean): Asset => ({
  id,
  state: 'ready',
  mime: 'image/png',
  sensitive,
})
// jsdom has neither a modal dialog nor media queries; the viewer only needs to
// reach the DOM here, not to render a real gallery.
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})
function mount(
  component: typeof MediaGallery | typeof MediaThumbs,
  assets: Asset[],
  showSensitive = false,
) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(component, { assets, showSensitive })
    .use(vaporInteropPlugin)
    .mount(el)
  unmount = () => app.$.appContext.app.unmount()
  return el
}
const veil = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('.group-veil')
const covered = (el: HTMLElement) =>
  [...el.querySelectorAll('[inert]')].length > 0
const viewer = () => document.querySelector('dialog.viewer')
/** "1 / n" — how many resources the viewer was actually handed. */
const offered = () =>
  Number(document.querySelector('.counter')?.textContent?.split('/', 2)[1])

describe.each([
  ['detail gallery', MediaGallery, '.frame'],
  ['list thumbnails', MediaThumbs, '.tile'],
] as const)('%s', (_name, component, tile) => {
  it('covers a wholly sensitive group once and opens the viewer on the next tap', async () => {
    const el = mount(component, [asset('a', true), asset('b', true)])
    expect(veil(el)?.textContent?.trim()).toBe('敏感内容，点按显示')
    // Nothing underneath may be reached by keyboard while the veil is up.
    expect(covered(el)).toBe(true)
    veil(el)!.click()
    await nextTick()
    expect(veil(el)).toBeNull()
    expect(covered(el)).toBe(false)
    expect(viewer()).toBeNull()
    el.querySelector<HTMLButtonElement>(tile)!.click()
    await nextTick()
    expect(viewer()).not.toBeNull()
  })

  it('keeps per-resource reveal for a mixed group and never opens on the first tap', async () => {
    const el = mount(component, [asset('a', true), asset('b', false)])
    expect(veil(el)).toBeNull()
    const sensitive = el.querySelector<HTMLButtonElement>(tile)!
    sensitive.click()
    await nextTick()
    expect(viewer()).toBeNull()
    expect(sensitive.className).not.toContain('blurred')
    sensitive.click()
    await nextTick()
    expect(viewer()).not.toBeNull()
  })

  it('offers every ready resource to the viewer, uncovered or not', async () => {
    const el = mount(component, [
      asset('a', false),
      asset('b', true),
      asset('c', true),
    ])
    el.querySelector<HTMLButtonElement>(tile)!.click()
    await nextTick()
    expect(offered()).toBe(3)
  })

  it('covers the group again when the assets change', async () => {
    const el = mount(component, [asset('a', true)])
    veil(el)!.click()
    await nextTick()
    expect(veil(el)).toBeNull()
    unmount()
    const next = mount(component, [asset('c', true)])
    expect(veil(next)).not.toBeNull()
  })
})

it('judges a thumbnail group by every resource, not only the four shown', () => {
  const assets = Array.from({ length: 5 }, (_, i) => asset(`a${i}`, i < 4))
  expect(veil(mount(MediaThumbs, assets))).toBeNull()
})
