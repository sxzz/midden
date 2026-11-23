import { randomUUIDv7 } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { submit } from '#capture/submit.ts'
import { collections, library, submissions, tags } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import { listTags, readAnnotation, updateAnnotation } from './annotations.ts'
import { deleteAll, deleteCollection } from './delete.ts'

function setup() {
  return testContext({
    platforms: [fakePlatform({ current: () => ({ text: 'x' }) })],
  })
}

describe('annotations', () => {
  test('notes and tags of a saved collection', () => {
    const ctx = setup()
    const { collectionId } = submit(ctx, { url: 'https://fake.test/p/1' })
    expect(readAnnotation(ctx.db, collectionId)).toEqual({ note: '', tags: [] })
    const tagged = updateAnnotation(ctx.db, collectionId, {
      note: 'remember',
      tagNames: [' b ', 'a', 'a'],
    })
    expect(tagged.note).toBe('remember')
    expect(tagged.tags.map((t) => t.name)).toEqual(['a', 'b'])
    // Clearing tags keeps the note and prunes unused tags.
    expect(updateAnnotation(ctx.db, collectionId, { tagIds: [] })).toEqual({
      note: 'remember',
      tags: [],
    })
    expect(listTags(ctx.db)).toEqual([])
  })

  test('rejects bad input and unknown tags without changing anything', () => {
    const ctx = setup()
    const { collectionId } = submit(ctx, { url: 'https://fake.test/p/1' })
    expect(() =>
      updateAnnotation(ctx.db, collectionId, { tagIds: [], tagNames: [] }),
    ).toThrow('invalid note or tags')
    expect(() =>
      updateAnnotation(ctx.db, collectionId, { tagNames: ['x'.repeat(65)] }),
    ).toThrow('invalid note or tags')
    expect(() =>
      updateAnnotation(ctx.db, collectionId, {
        note: 'changed',
        tagIds: [randomUUIDv7()],
      }),
    ).toThrow('not found')
    expect(readAnnotation(ctx.db, collectionId).note).toBe('')
    expect(() => readAnnotation(ctx.db, randomUUIDv7())).toThrow('not found')
  })
})

describe('delete', () => {
  test('a deleted collection leaves the library and starts its removal', () => {
    const ctx = setup()
    const { collectionId } = submit(ctx, { url: 'https://fake.test/p/1' })
    updateAnnotation(ctx.db, collectionId, { tagNames: ['t'] })
    deleteCollection(ctx.db, collectionId)
    expect(ctx.db.select().from(library).all()).toEqual([])
    expect(ctx.db.select().from(tags).all()).toEqual([])
    expect(
      ctx.db.select().from(collections).get()?.unreferencedAt,
    ).toBeInstanceOf(Date)
    expect(() => deleteCollection(ctx.db, collectionId)).toThrow('not found')
  })

  test('delete all keeps what was saved after the cutoff', () => {
    const ctx = setup()
    submit(ctx, { url: 'https://fake.test/p/1' })
    submit(ctx, { url: 'https://fake.test/p/2' })
    const cutoff = new Date(Date.now() + 1)
    expect(deleteAll(ctx.db, cutoff)).toEqual({ collections: 2, records: 2 })
    expect(ctx.db.select().from(submissions).all()).toEqual([])
    expect(deleteAll(ctx.db, cutoff)).toEqual({ collections: 0, records: 0 })
  })
})
