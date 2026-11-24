import { expect, it } from 'vitest'
import { LABEL_HEIGHT, placeLabels, type LabelCandidate } from './graph-labels'

const viewport = { width: 800, height: 600 }

const node = (
  key: string,
  x: number,
  y: number,
  options: Partial<LabelCandidate> = {},
): LabelCandidate => ({
  key,
  text: key,
  x,
  y,
  radius: 20,
  width: 60,
  forced: false,
  priority: 0,
  ...options,
})

it('writes a name under each avatar that has room', () => {
  const placed = placeLabels(
    [node('a', 100, 100), node('b', 300, 100)],
    viewport,
  )
  expect(placed).toEqual([
    { key: 'a', text: 'a', x: 100, y: 123, width: 60, forced: false },
    { key: 'b', text: 'b', x: 300, y: 123, width: 60, forced: false },
  ])
})

it('never writes two names over each other: the more followed wins', () => {
  // Two accounts at nearly one place would write their names at one spot.
  const placed = placeLabels(
    [
      node('小云', 200, 200, { priority: 10 }),
      node('小智', 202, 201, { priority: 20 }),
    ],
    viewport,
  )
  expect(placed.map((l) => l.key)).toEqual(['小智'])
  // Side by side, closer than their names are wide.
  const row = placeLabels(
    [0, 1, 2, 3, 4].map((i) =>
      node(`n${i}`, 100 + i * 45, 300, { priority: i }),
    ),
    viewport,
  )
  for (const a of row)
    for (const b of row)
      if (a !== b)
        expect(
          Math.abs(a.x - b.x) >= (a.width + b.width) / 2 ||
            Math.abs(a.y - b.y) >= LABEL_HEIGHT,
        ).toBe(true)
})

it('keeps names off other avatars', () => {
  // b sits right under a, where a's name would go.
  const placed = placeLabels(
    [node('a', 100, 100, { priority: 1 }), node('b', 100, 145)],
    viewport,
  )
  expect(placed.map((l) => l.key)).toEqual(['b'])
})

it('names small avatars only when forced: the center, hovered or chosen', () => {
  const small = { radius: 8 }
  const placed = placeLabels(
    [
      node('c', 100, 100, { ...small, forced: true, priority: 2 }),
      node('x', 300, 100, small),
      node('hovered', 500, 100, { ...small, forced: true, priority: 4 }),
    ],
    viewport,
  )
  expect(placed.map((l) => l.key)).toEqual(['hovered', 'c'])
})

it('leaves out names outside the view, or outside the focus', () => {
  const placed = placeLabels(
    [node('far', -200, 100), node('dim', 300, 300, { hidden: true })],
    viewport,
  )
  expect(placed).toEqual([])
})
