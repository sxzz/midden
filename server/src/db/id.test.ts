import { expect, test } from 'vitest'
import { newId } from './id.ts'

test('ids sort in the order they were made, within a millisecond too', () => {
  const ids = Array.from({ length: 10_000 }, newId)
  expect(ids.toSorted()).toEqual(ids)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids)
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    )
})
