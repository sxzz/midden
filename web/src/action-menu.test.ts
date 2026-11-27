import { describe, expect, it } from 'vitest'
import { menuKind, placeMenu } from './action-menu'

describe('menuKind', () => {
  it('follows the click’s own pointer', () => {
    expect(menuKind({ pointerType: 'mouse', detail: 1 }, '', false)).toBe(
      'dropdown',
    )
    // A mouse on a touch device (an iPad with a trackpad) still gets one.
    expect(menuKind({ pointerType: 'mouse', detail: 1 }, 'touch', false)).toBe(
      'dropdown',
    )
    expect(menuKind({ pointerType: 'touch', detail: 1 }, '', true)).toBe(
      'sheet',
    )
    expect(menuKind({ pointerType: 'pen', detail: 1 }, '', true)).toBe('sheet')
  })

  it('takes the last pressed pointer for clicks that are not pointer events', () => {
    expect(menuKind({ detail: 1 }, 'mouse', false)).toBe('dropdown')
    expect(menuKind({ detail: 1 }, 'touch', true)).toBe('sheet')
  })

  it('asks the primary pointer for clicks from the keyboard', () => {
    // A pressed pointer does not count for a click that came from a key.
    expect(menuKind({ pointerType: '', detail: 0 }, 'touch', true)).toBe(
      'dropdown',
    )
    expect(menuKind({ pointerType: '', detail: 0 }, 'mouse', false)).toBe(
      'sheet',
    )
    expect(menuKind(undefined, '', true)).toBe('dropdown')
    expect(menuKind(undefined, '', false)).toBe('sheet')
  })
})

describe('placeMenu', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 240, height: 300 }
  const box = (left: number, top: number) => ({
    left,
    top,
    right: left + 40,
    bottom: top + 40,
  })

  it('goes under its button, lined up with the nearer edge', () => {
    expect(placeMenu(box(100, 50), size, viewport)).toEqual({
      top: 94,
      left: 100,
      maxHeight: undefined,
      above: false,
    })
    // In the right half, its right edge meets the button's.
    expect(placeMenu(box(900, 50), size, viewport).left).toBe(940 - 240)
  })

  it('stays inside the window sideways', () => {
    expect(placeMenu(box(2, 50), size, viewport).left).toBe(8)
    const wide = { width: 400, height: 300 }
    expect(
      placeMenu(box(100, 50), wide, { width: 500, height: 800 }).left,
    ).toBe(500 - 8 - 400)
  })

  it('flips above when there is no room below', () => {
    const spot = placeMenu(box(900, 700), size, viewport)
    expect(spot).toMatchObject({ top: 700 - 4 - 300, above: true })
    expect(spot.maxHeight).toBeUndefined()
  })

  it('scrolls on the roomier side when it fits on neither', () => {
    const tall = { width: 240, height: 900 }
    expect(placeMenu(box(100, 100), tall, viewport)).toEqual({
      top: 144,
      left: 100,
      maxHeight: 800 - 140 - 4 - 8,
      above: false,
    })
    const up = placeMenu(box(100, 600), tall, viewport)
    expect(up).toEqual({
      top: 8,
      left: 100,
      maxHeight: 600 - 4 - 8,
      above: true,
    })
  })
})
