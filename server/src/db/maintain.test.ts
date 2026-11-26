import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { collectCollections } from '#capture/maintenance.ts'
import { deleteCollections } from '#library/delete.ts'
import { listCollections } from '#library/list.ts'
import { readSetting } from '#settings.ts'
import {
  capture,
  entity,
  graph,
  libraryContext,
  searchIndexes,
} from '#testing/library.ts'
import { openDatabase, type Database } from './client.ts'
import { maintainDatabase } from './maintain.ts'
import type { CaptureContext } from '#capture/context.ts'

let ctx: CaptureContext | undefined
const open: Database[] = []
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
  for (const db of open.splice(0)) if (db.$client.isOpen) db.$client.close()
})

const TEXTS = [
  'a marmalade sunset over the bay',
  '終末地 的同人图',
  'xiaomouz draws cats',
  'blue whale song',
  '猫咪 在睡觉',
  'the quick brown fox',
  '原神 新角色',
  'sunset again, with whales',
  'cats and 猫咪',
  'nothing to see',
  'brown bears fishing',
  '小狗 和 猫咪',
]
const QUERIES = [
  'sunset',
  '猫咪',
  '猫',
  'cats',
  'xiaomuoz',
  'brown',
  'whale',
  '原神',
  'ai',
]

/**
 * A library with gaps in the catalog's rowids: some collections deleted
 * and collected, some captured again. Its search results, by query.
 */
async function library() {
  const made = libraryContext((req) => {
    const text = TEXTS[Number(req.externalId)] ?? ''
    return {
      text,
      graph: graph([entity('root', 'fake.post', req.externalId, { text })]),
    }
  })
  ctx = made.ctx
  const ids: string[] = []
  for (const [i] of TEXTS.entries())
    ids.push((await capture(made.ctx, `https://fake.test/p/${i}`)).collectionId)
  deleteCollections(made.ctx.db, [ids[0]!, ids[4]!, ids[9]!])
  await collectCollections(made.ctx)
  await capture(made.ctx, { refreshId: ids[1]! })
  return made.ctx
}

const results = (c: CaptureContext) =>
  Object.fromEntries(
    QUERIES.map((q) => [
      q,
      listCollections(c, { q }).items.map((item) => item.id),
    ]),
  )

/** The in-memory database as a file, as a deployment has it. */
function toFile(db: Database): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-maintain-'))
  const file = path.join(dir, 'midden.db')
  db.$client.prepare('VACUUM INTO ?').run(file)
  return file
}

function maintain(
  file: string,
  options: { vacuum?: boolean; rebuildSearch?: boolean } = {},
) {
  const lines: string[] = []
  const code = maintainDatabase(file, {
    ...options,
    print: (line) => lines.push(line),
    now: () => new Date('2026-11-26T00:00:00Z'),
  })
  return { code, lines }
}

function reopen(file: string) {
  const db = openDatabase(file)
  open.push(db)
  return db
}

describe('maintain', () => {
  test('a full vacuum keeps search results as they were', async () => {
    const c = await library()
    const before = results(c)
    expect(before['猫咪']).toHaveLength(2)
    const file = toFile(c.db)
    const dir = path.dirname(file)
    mkdirSync(path.join(dir, 'backups', 'maintain'), { recursive: true })
    writeFileSync(path.join(dir, 'backups', 'maintain', 'midden-old.db'), '')
    const { code, lines } = maintain(file, { vacuum: true })
    expect(code).toBe(0)
    expect(lines).toContain('  catalog_fts: ok')
    expect(lines).toContain('  catalog_cjk: ok')
    // The original is kept, the one before it goes, and nothing is left
    // beside the new one.
    expect(readdirSync(dir).toSorted()).toEqual(['backups', 'midden.db'])
    expect(readdirSync(path.join(dir, 'backups', 'maintain'))).toEqual([
      'midden-2026-11-26T00-00-00-000Z.db',
    ])

    const db = reopen(file)
    // The page's database composition is read again when the worker starts.
    expect(readSetting(db, 'db_composition_stale')).toContain('"at"')
    expect(results({ ...c, db })).toEqual(before)
    const index = searchIndexes(db)
    expect(index.kept).toEqual(index.fresh)
    expect(db.$client.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(2)
    expect(db.$client.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe(
      'wal',
    )
  })

  test('search indexes that do not match the catalog are built again', async () => {
    const c = await library()
    const before = results(c)
    const file = toFile(c.db)
    // As a renumbered catalog would leave them: a document under a key no
    // row has, and a row without one.
    const broken = reopen(file)
    broken.$client.exec(`
      INSERT INTO catalog_fts (rowid, text, name, quoted, extra)
        VALUES (999999, 'stray sunset', '', '', '');
      DELETE FROM catalog_cjk WHERE rowid = (SELECT max(id) FROM catalog);`)
    broken.$client.close()

    const { code, lines } = maintain(file)
    expect(code).toBe(0)
    expect(lines).toContain('  catalog_fts: 0 missing, 1 extra')
    expect(lines).toContain('  catalog_cjk: 1 missing, 0 extra')
    expect(
      lines.some((line) => line.startsWith('search indexes rebuilt')),
    ).toBe(true)
    const db = reopen(file)
    expect(results({ ...c, db })).toEqual(before)
    const index = searchIndexes(db)
    expect(index.kept).toEqual(index.fresh)
  })

  test('refuses while another connection has the database open', async () => {
    const c = await library()
    const file = toFile(c.db)
    const app = reopen(file)
    const { code, lines } = maintain(file, { vacuum: true })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(
      /stop the web process, the worker and Litestream/,
    )
    expect(existsSync(path.join(path.dirname(file), 'backups'))).toBe(false)
    expect(results({ ...c, db: app })).toEqual(results(c))
  })
})
