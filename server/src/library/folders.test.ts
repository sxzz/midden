import { afterEach, describe, expect, test, vi } from 'vitest'
import { isAppError } from '#errors.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { listTags, updateAnnotation } from './annotations.ts'
import { filterCounts } from './counts.ts'
import { deleteCollection } from './delete.ts'
import { parseFilterQuery } from './filter-query.ts'
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from './folders.ts'
import { listCollections } from './list.ts'
import type { CaptureContext } from '#capture/context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  const made = libraryContext((req) => ({
    text: `post ${req.externalId}`,
    graph: graph(
      [
        entity('root', 'fake.post', req.externalId),
        entity(
          'author',
          'fake.profile',
          req.externalId.startsWith('a') ? 'alice' : 'bob',
        ),
      ],
      ['root', 'authored_by', 'author'],
    ),
  }))
  ctx = made.ctx
  return made.ctx
}

const post = (id: string) => `https://fake.test/p/${id}`

/** Every page the list shows for a query string. */
function listed(c: CaptureContext, query: string) {
  const { filter } = parseFilterQuery(query)
  let total = 0
  let cursor: string | undefined
  do {
    const page = listCollections(c, filter, cursor)
    total += page.items.length
    cursor = page.next_cursor
  } while (cursor)
  return total
}

function fails(run: () => unknown, kind: string, message?: string) {
  try {
    run()
  } catch (error) {
    expect(isAppError(error)).toBe(true)
    expect(error).toMatchObject({ kind, ...(message ? { message } : {}) })
    return
  }
  throw new Error('expected an error')
}

describe('folders', () => {
  test('count what the list shows under their filter, live', async () => {
    const c = setup()
    const a1 = (await capture(c, post('a1'))).collectionId
    await capture(c, post('a2'))
    await capture(c, post('b1'))
    const tag = updateAnnotation(c.db, a1, { tagNames: ['读'] }).tags[0]!
    const queries = [
      '',
      'entity_type=fake.post',
      'q=a1',
      `tag=${tag.id}`,
      'author=fake/fake.profile/alice',
      'author=fake/fake.profile/alice&author=fake/fake.profile/bob',
      'media_type=video',
      `related_to=${a1}`,
    ]
    for (const [i, filter] of queries.entries())
      createFolder(c.db, { name: `f${i}`, filter })
    const counts = async () =>
      (await listFolders(c.db)).map((folder) => folder.count)
    expect(await counts()).toEqual(queries.map((q) => listed(c, q)))
    expect(await counts()).toEqual([3, 3, 1, 1, 2, 3, 0, 0])
    expect((await listFolders(c.db))[0]!.types).toEqual({ 'fake.post': 3 })
    expect((await listFolders(c.db))[6]!.types).toEqual({})

    // New saves and deletions show up without touching the folders.
    const a3 = (await capture(c, post('a3'))).collectionId
    expect(await counts()).toEqual([4, 4, 1, 1, 3, 4, 0, 0])
    deleteCollection(c.db, a3)
    expect(await counts()).toEqual([3, 3, 1, 1, 2, 3, 0, 0])
  })

  test('store the filter in one canonical form', () => {
    const c = setup()
    const folder = createFolder(c.db, {
      name: '  合集  ',
      filter:
        'sort=saved&q=&layout=album&cursor=abc&entity_type=fake.post&author=fake/u/2&author=fake/u/1&order=asc',
    })
    expect(folder).toMatchObject({
      name: '合集',
      filter:
        'author=fake%2Fu%2F1&author=fake%2Fu%2F2&entity_type=fake.post&order=asc&sort=saved',
      count: 0,
    })
    expect(
      updateFolder(c.db, folder.id, { filter: '?entity_type=fake.post' }),
    ).toMatchObject({ name: '合集', filter: 'entity_type=fake.post' })
  })

  test('count a relative save date by the day it is counted on', async () => {
    const c = setup()
    await capture(c, post('a1'))
    const filter = 'saved_within=1d&time_zone=Asia%2FShanghai'
    expect(createFolder(c.db, { name: '今天', filter })).toMatchObject({
      filter,
      count: 1,
      types: { 'fake.post': 1 },
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Nothing was written, yet a later day selects nothing.
      vi.setSystemTime(Date.now() + 2 * 86_400_000)
      expect(filterCounts(c.db, filter).count).toBe(0)
      expect((await listFolders(c.db))[0]!.count).toBe(0)
      expect(
        filterCounts(c.db, 'saved_within=3d&time_zone=Asia/Shanghai'),
      ).toEqual({ count: 1, types: { 'fake.post': 1 } })
    } finally {
      vi.useRealTimers()
    }
    // A zone only belongs to a relative date.
    expect(
      updateFolder(c.db, (await listFolders(c.db))[0]!.id, {
        filter: 'time_zone=UTC&q=a&saved_within=',
      }).filter,
    ).toBe('q=a')
  })

  test('reject what the list rejects, and bad names', () => {
    const c = setup()
    for (const filter of [
      'sort=nonsense',
      'tag=a&tag=b',
      'tag=not-a-uuid',
      'saved_from=yesterday',
      'saved_from=2026-02-01T00:00:00Z&saved_before=2026-01-01T00:00:00Z',
      'saved_within=7',
      'saved_within=7d&time_zone=Nowhere%2FCity',
      'saved_within=7d&saved_from=2026-01-01T00:00:00Z',
      'media_type=audio',
      `q=${'x'.repeat(501)}`,
      'x'.repeat(20_000),
    ])
      fails(() => createFolder(c.db, { name: 'f', filter }), 'invalid_filter')
    for (const name of ['', ' '.repeat(3), 'x'.repeat(65), 'a\0b'])
      fails(
        () => createFolder(c.db, { name, filter: '' }),
        'invalid_folder',
        '收藏夹名称不能为空，最多 64 字',
      )
    const first = createFolder(c.db, { name: '甲', filter: '' })
    const second = createFolder(c.db, { name: '乙', filter: '' })
    fails(
      () => createFolder(c.db, { name: ' 甲', filter: '' }),
      'conflict',
      '已有同名的收藏夹',
    )
    fails(() => updateFolder(c.db, second.id, { name: '甲' }), 'conflict')
    // Keeping its own name is no conflict.
    expect(updateFolder(c.db, first.id, { name: '甲' }).name).toBe('甲')
    fails(
      () => updateFolder(c.db, first.id, { filter: 'order=up' }),
      'invalid_filter',
    )
    expect(updateFolder(c.db, first.id, { name: '丙' })).toMatchObject({
      name: '丙',
      filter: '',
    })
    const missing = '00000000-0000-7000-8000-000000000000'
    fails(() => updateFolder(c.db, missing, { name: '丁' }), 'not_found')
    fails(() => deleteFolder(c.db, missing), 'not_found')
  })

  test('keep the tag they filter on while nothing carries it', async () => {
    const c = setup()
    const a1 = (await capture(c, post('a1'))).collectionId
    const kept = updateAnnotation(c.db, a1, { tagNames: ['kept'] }).tags[0]!
    const folder = createFolder(c.db, { name: 'f', filter: `tag=${kept.id}` })
    updateAnnotation(c.db, a1, { tagIds: [] })
    expect(listTags(c.db)).toEqual([kept])
    expect((await listFolders(c.db))[0]!.count).toBe(0)
    updateAnnotation(c.db, a1, { tagIds: [kept.id] })
    expect((await listFolders(c.db))[0]!.count).toBe(1)

    updateAnnotation(c.db, a1, { tagIds: [] })
    updateFolder(c.db, folder.id, { filter: '' })
    expect(listTags(c.db)).toEqual([])

    const other = updateAnnotation(c.db, a1, { tagNames: ['other'] }).tags[0]!
    updateFolder(c.db, folder.id, { filter: `tag=${other.id}` })
    updateAnnotation(c.db, a1, { tagIds: [] })
    expect(listTags(c.db)).toEqual([other])
    deleteFolder(c.db, folder.id)
    expect(listTags(c.db)).toEqual([])
    expect(await listFolders(c.db)).toEqual([])
  })
})
