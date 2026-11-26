import { describe, expect, test } from 'vitest'
import { openDatabase } from '#db/client.ts'
import { COLUMNS, UPDATE_GROUPS } from './catalog.ts'

describe('catalog', () => {
  test('updates every stored column, each in one group', () => {
    const grouped = UPDATE_GROUPS.flat()
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped.toSorted()).toEqual(COLUMNS.slice(1).toSorted())
    const db = openDatabase(':memory:')
    // But the id, which SQLite assigns.
    const stored = db.$client
      .prepare(`SELECT name FROM pragma_table_info(?) WHERE name <> 'id'`)
      .all('catalog')
      .map((row) => row.name)
    expect(COLUMNS.toSorted()).toEqual(stored.toSorted())
    db.$client.close()
  })
})
