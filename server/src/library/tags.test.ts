import { afterEach, describe, expect, test } from 'vitest'
import { isAppError } from '#errors.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { listTags, readAnnotation, updateAnnotation } from './annotations.ts'
import { filterCounts } from './counts.ts'
import { createFolder, listFolders } from './folders.ts'
import { deleteTag, renameTag } from './tags.ts'
import type { CaptureContext } from '#capture/context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

async function setup() {
  const made = libraryContext((req) => ({
    text: `post ${req.externalId}`,
    graph: graph([entity('root', 'fake.post', req.externalId)]),
  }))
  ctx = made.ctx
  const ids = []
  for (const id of ['1', '2', '3'])
    ids.push(
      (await capture(made.ctx, `https://fake.test/p/${id}`)).collectionId,
    )
  return { c: made.ctx, ids }
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

const names = (c: CaptureContext, id: string) =>
  readAnnotation(c.db, id).tags.map((t) => t.name)

describe('tags', () => {
  test('rename in place, keeping their id', async () => {
    const { c, ids } = await setup()
    const tag = updateAnnotation(c.db, ids[0]!, { tagNames: ['猫'] }).tags[0]!
    const folder = createFolder(c.db, { name: 'f', filter: `tag=${tag.id}` })
    expect(renameTag(c.db, tag.id, '  猫猫 ')).toEqual({
      tag: { id: tag.id, name: '猫猫' },
      merged: false,
      moved: 0,
    })
    expect(listTags(c.db)).toEqual([{ id: tag.id, name: '猫猫' }])
    expect(names(c, ids[0]!)).toEqual(['猫猫'])
    expect((await listFolders(c.db))[0]).toMatchObject({
      filter: folder.filter,
      count: 1,
    })
    // Its own name again changes nothing.
    expect(renameTag(c.db, tag.id, '猫猫').merged).toBe(false)
  })

  test('merge into a tag that already has the name', async () => {
    const { c, ids } = await setup()
    const [a, b, d] = ids as [string, string, string]
    const old = updateAnnotation(c.db, a, { tagNames: ['旧'] }).tags[0]!
    updateAnnotation(c.db, b, { tagNames: ['旧', '新'] })
    const kept = updateAnnotation(c.db, d, { tagNames: ['新'] }).tags[0]!
    const folder = createFolder(c.db, {
      name: 'f',
      filter: `tag=${old.id}&sort=saved&q=post`,
    })
    const other = createFolder(c.db, { name: 'g', filter: 'q=post' })
    // Counted under the old tag first, so the cache has to let go.
    expect(filterCounts(c.db, `tag=${kept.id}`).count).toBe(2)

    // b carried both, so only a moves.
    expect(renameTag(c.db, old.id, '新')).toEqual({
      tag: kept,
      merged: true,
      moved: 1,
    })
    expect(listTags(c.db)).toEqual([kept])
    for (const id of ids) expect(names(c, id)).toEqual(['新'])
    expect(filterCounts(c.db, `tag=${kept.id}`).count).toBe(3)
    const saved = await listFolders(c.db)
    expect(saved.find((f) => f.id === folder.id)).toMatchObject({
      filter: `q=post&sort=saved&tag=${kept.id}`,
      count: 3,
    })
    expect(saved.find((f) => f.id === other.id)?.filter).toBe('q=post')
  })

  test('a merged tag only a folder kept still rewrites the folder', async () => {
    const { c, ids } = await setup()
    const old = updateAnnotation(c.db, ids[0]!, { tagNames: ['旧'] }).tags[0]!
    createFolder(c.db, { name: 'f', filter: `tag=${old.id}` })
    updateAnnotation(c.db, ids[0]!, { tagIds: [] })
    const kept = updateAnnotation(c.db, ids[1]!, { tagNames: ['新'] }).tags[0]!
    expect(renameTag(c.db, old.id, '新')).toMatchObject({ moved: 0 })
    expect((await listFolders(c.db))[0]!.filter).toBe(`tag=${kept.id}`)
  })

  test('reject names the way creating a tag does', async () => {
    const { c, ids } = await setup()
    const tag = updateAnnotation(c.db, ids[0]!, { tagNames: ['猫'] }).tags[0]!
    for (const name of ['', '  ', 'x'.repeat(65), 'a\0b'])
      fails(
        () => renameTag(c.db, tag.id, name),
        'invalid_tag',
        '标签名不能为空，最多 64 字',
      )
    expect(renameTag(c.db, tag.id, '字'.repeat(64)).tag.name).toHaveLength(64)
    const missing = '00000000-0000-7000-8000-000000000000'
    fails(() => renameTag(c.db, missing, '狗'), 'not_found')
    fails(() => deleteTag(c.db, missing), 'not_found')
  })

  test('delete with their associations, unless a folder filters on them', async () => {
    const { c, ids } = await setup()
    const made = updateAnnotation(c.db, ids[0]!, { tagNames: ['猫', '狗'] })
    const cat = made.tags.find((t) => t.name === '猫')!
    const dog = made.tags.find((t) => t.name === '狗')!
    updateAnnotation(c.db, ids[1]!, { tagIds: [cat.id] })
    createFolder(c.db, { name: '狗狗', filter: `tag=${dog.id}` })

    deleteTag(c.db, cat.id)
    expect(names(c, ids[0]!)).toEqual(['狗'])
    expect(names(c, ids[1]!)).toEqual([])
    fails(
      () => deleteTag(c.db, dog.id),
      'conflict',
      '收藏夹「狗狗」按此标签筛选，请先修改收藏夹',
    )
    expect(listTags(c.db)).toEqual([dog])
  })
})
