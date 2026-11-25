import { describe, expect, it } from 'vitest'
import {
  bottomBudget,
  captionLines,
  fitBox,
  mediaInsets,
  minMediaHeight,
  type Box,
  type Chrome,
  type Insets,
  type Size,
} from './media-fit'

const phone = { width: 390, height: 844 }
const desktop = { width: 1280, height: 800 }
const chrome: Chrome = { top: 68, bottom: 110, side: 14 }

const inside = (box: Box, viewport: Size, insets: Insets) =>
  box.x >= insets.left - 0.01 &&
  box.y >= insets.top - 0.01 &&
  box.x + box.width <= viewport.width - insets.right + 0.01 &&
  box.y + box.height <= viewport.height - insets.bottom + 0.01

describe('bottomBudget', () => {
  it('leaves the media its minimum height', () => {
    expect(bottomBudget(844, 68)).toBe(844 - 68 - Math.ceil(844 * 0.4))
    expect(minMediaHeight(300)).toBe(160)
  })
  it('keeps the paging area visible in a very short viewport', () => {
    expect(bottomBudget(320, 68)).toBe(92)
    expect(bottomBudget(390, 68)).toBe(162)
    expect(bottomBudget(200, 68)).toBe(72)
  })
})

describe('captionLines', () => {
  it('shows three lines where there is room', () => {
    expect(captionLines(bottomBudget(844, 68))).toBe(3)
    expect(captionLines(bottomBudget(800, 68))).toBe(3)
  })
  it('shows fewer in a short viewport', () => {
    expect(captionLines(bottomBudget(500, 68))).toBe(2)
    expect(captionLines(bottomBudget(390, 68))).toBe(1)
  })
})

describe('mediaInsets', () => {
  it('reserves the bars above and below an image', () => {
    expect(mediaInsets(phone, chrome, false)).toEqual({
      top: 68,
      bottom: 110,
      left: 0,
      right: 0,
    })
  })
  it('keeps a video clear of the sides too', () => {
    const insets = mediaInsets(phone, chrome, true)
    expect(insets.left).toBe(14)
    expect(insets.right).toBe(14)
  })
  it('caps a long text area so the media keeps its height', () => {
    const insets = mediaInsets(phone, { ...chrome, bottom: 900 }, false)
    expect(insets.bottom).toBe(bottomBudget(844, 68))
    expect(844 - insets.top - insets.bottom).toBeGreaterThanOrEqual(
      minMediaHeight(844),
    )
  })
  it('reserves nothing below when there is neither bar nor caption', () => {
    expect(mediaInsets(phone, { ...chrome, bottom: 0 }, false).bottom).toBe(0)
  })
  it('adds the media’s own caption to the bar at the bottom', () => {
    expect(mediaInsets(phone, chrome, false, 90).bottom).toBe(110 + 90)
    expect(mediaInsets(phone, chrome, false, 0).bottom).toBe(110)
  })
})

describe('fitBox', () => {
  it.each([
    ['a tall image on a phone', phone, { width: 900, height: 2400 }],
    ['a wide image on a phone', phone, { width: 2400, height: 600 }],
    ['a tall image on a desktop', desktop, { width: 900, height: 2400 }],
    ['a wide image on a desktop', desktop, { width: 2400, height: 600 }],
    ['a small image', desktop, { width: 120, height: 90 }],
  ])('keeps %s inside the free area', (_name, viewport, media) => {
    const insets = mediaInsets(viewport, chrome, false)
    const box = fitBox(viewport, insets, media)
    expect(inside(box, viewport, insets)).toBe(true)
    expect(box.width / box.height).toBeCloseTo(media.width / media.height)
  })
  it('does not enlarge an image past its own size', () => {
    const box = fitBox(desktop, mediaInsets(desktop, chrome, false), {
      width: 120,
      height: 90,
    })
    expect(box).toMatchObject({ width: 120, height: 90 })
  })
  it('centres the media in the free area, not the viewport', () => {
    const insets = mediaInsets(phone, chrome, false)
    const box = fitBox(phone, insets, { width: 100, height: 100 })
    expect(box.y).toBe(68 + (844 - 68 - 110 - 100) / 2)
  })
  it('scales a video up to fill the free area when asked', () => {
    const insets = mediaInsets(phone, chrome, true)
    const box = fitBox(phone, insets, { width: 640, height: 360 }, true)
    expect(box.width).toBeCloseTo(362)
    expect(inside(box, phone, insets)).toBe(true)
  })
  it('gives a long caption no way to cover the media', () => {
    const insets = mediaInsets(phone, { ...chrome, bottom: 700 }, false)
    const box = fitBox(phone, insets, { width: 900, height: 2400 })
    expect(box.y + box.height).toBeLessThanOrEqual(844 - insets.bottom + 0.01)
    expect(box.height).toBeGreaterThanOrEqual(minMediaHeight(844) - 0.01)
  })
  it('returns the free area for media of unknown size', () => {
    const insets = mediaInsets(phone, chrome, false)
    expect(fitBox(phone, insets, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 68,
      width: 390,
      height: 844 - 68 - 110,
    })
  })
})
