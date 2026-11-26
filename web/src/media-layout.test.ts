import { describe, expect, it } from 'vitest'
import {
  layoutMedia,
  MAX_RATIO,
  MIN_RATIO,
  ratioOf,
  singleBox,
  track,
  UNKNOWN_RATIO,
} from './media-layout'

const item = (ratio?: number, box?: boolean) => ({ ratio, box })
const shape = (items: ReturnType<typeof item>[]) =>
  layoutMedia(items).map((row) => ({
    ratio: row.ratio,
    cells: row.cells.map((cell) => items.indexOf(cell.item)),
  }))

describe('ratioOf', () => {
  it('needs both sides', () => {
    expect(ratioOf({ width: 600, height: 100 })).toBe(6)
    expect(ratioOf({ width: 600 })).toBeUndefined()
    expect(ratioOf({ width: 0, height: 0 })).toBeUndefined()
    expect(ratioOf({})).toBeUndefined()
  })
})

describe('singleBox', () => {
  it('follows the media within the limits', () => {
    expect(singleBox(16 / 9)).toBe(16 / 9)
    expect(singleBox(1)).toBe(1)
    expect(singleBox(5.5)).toBe(5.5)
  })

  it('keeps every ordinary portrait as it is, down to 1:3', () => {
    for (const ratio of [9 / 16, 3 / 4, 4 / 5, 1 / 3])
      expect(singleBox(ratio)).toBe(ratio)
  })

  it('stops what is narrower than 1:3 and wider than 6:1', () => {
    expect(singleBox(1 / 5)).toBe(MIN_RATIO)
    expect(singleBox(12)).toBe(MAX_RATIO)
    expect(MIN_RATIO).toBeCloseTo(1 / 3)
    expect(MAX_RATIO).toBe(6)
  })

  it('reserves 4:3 while the shape is unknown', () => {
    expect(singleBox()).toBe(UNKNOWN_RATIO)
  })
})

describe('layoutMedia', () => {
  it('gives one item a row of its own shape', () => {
    expect(shape([item(6)])).toEqual([{ ratio: 6, cells: [0] }])
  })

  it('puts two items of ordinary shapes side by side at one height', () => {
    const rows = layoutMedia([item(1), item(2)])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ratio).toBe(3)
    // Widths in proportion to the ratios: equal heights.
    expect(rows[0]!.cells.map((cell) => cell.flex)).toEqual([1, 2])
  })

  it('stacks two wide items instead of making a strip of them', () => {
    expect(shape([item(6), item(6)])).toEqual([
      { ratio: 6, cells: [0] },
      { ratio: 6, cells: [1] },
    ])
    // Two 16:9 would make a row under a third as tall as wide.
    expect(layoutMedia([item(16 / 9), item(16 / 9)])).toHaveLength(2)
  })

  it('keeps a panorama from squeezing its neighbour', () => {
    // 6:1 beside 1:1 is a 7:1 strip: stacked, not 1:1 shrunk to a sliver.
    expect(shape([item(6), item(1)])).toEqual([
      { ratio: 6, cells: [0] },
      { ratio: 1, cells: [1] },
    ])
  })

  it('shares a row between tall items at their own shapes', () => {
    const rows = layoutMedia([item(9 / 16), item(3 / 4)])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ratio).toBeCloseTo(9 / 16 + 3 / 4)
    expect(rows[0]!.cells.map((cell) => cell.flex)).toEqual([9 / 16, 3 / 4])
  })

  it('takes items two at a time, the last alone', () => {
    const rows = layoutMedia([item(1), item(1), item(1)])
    expect(rows.map((row) => row.cells.length)).toEqual([2, 1])
    expect(rows.map((row) => row.ratio)).toEqual([2, 1])
    expect(layoutMedia([item(1), item(1), item(1), item(1)])).toHaveLength(2)
  })

  it('pairs the next two once a wide item was stacked', () => {
    const rows = layoutMedia([item(6), item(1), item(1)])
    expect(rows.map((row) => row.cells.length)).toEqual([1, 2])
  })

  it('assumes 4:3 for unknown shapes', () => {
    expect(shape([item(), item()])).toEqual([
      { ratio: UNKNOWN_RATIO * 2, cells: [0, 1] },
    ])
  })

  it('leaves what is not media as a plain row, never in a pair', () => {
    const rows = layoutMedia([item(1), item(undefined, false), item(1)])
    expect(rows.map((row) => row.ratio)).toEqual([1, undefined, 1])
  })
})

describe('track', () => {
  it('scales a share up so a lone portrait still fills its row', () => {
    expect(track(9 / 16)).toBe('minmax(0, 562.5fr)')
    expect(track(2)).toBe('minmax(0, 2000fr)')
  })
})
