// Check on a copy of a real database that the `folder_queries` migration
// keeps every folder: the query it writes selects the same collections, and
// counts the same, as the filter it replaces. With `seed`, folders of more
// shapes are added first (authors, tags any and all, follows, a post's
// relatives, dates, words the query language would read as syntax).
//
//   node scripts/verify-folder-queries.ts <db copy> [seed]
//
// The copy must not be migrated past `folder_queries` yet; this migrates it.
import process from 'node:process'
import { sql } from 'drizzle-orm'
import { openDatabase, type Database } from '#db/client.ts'
import { newId } from '#db/id.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import { catalogTypes, folderSelection } from '#library/folder-query.ts'
import {
  countCollections,
  wholeSelection,
  type CollectionFilter,
  type QueryExtra,
} from '#library/list.ts'

const [file, seed] = process.argv.slice(2)
if (!file) {
  console.error('usage: verify-folder-queries.ts <db copy> [seed]')
  process.exit(2)
}

function members(db: Database, filter: CollectionFilter, extra?: QueryExtra) {
  const { ctes, source, where } = wholeSelection(db, filter, undefined, extra)
  return db
    .all<{ id: string }>(
      sql`${ctes} SELECT k.collection_id AS id FROM ${sql.raw(source)} WHERE ${where}`,
    )
    .map((row) => row.id)
    .toSorted()
}

const old = openDatabase(file, { migrate: false })
const columns = old
  .all<{ name: string }>(sql`SELECT name FROM pragma_table_info('folders')`)
  .map((row) => row.name)
if (!columns.includes('filter')) {
  console.error('folders already hold queries: nothing to check')
  process.exit(1)
}

if (seed) {
  const one = <T>(query: string) => old.$client.prepare(query).all() as T[]
  const authors = one<{ key: string }>(
    `SELECT e.platform || '/' || e.kind || '/' || e.external_id AS key
     FROM catalog k JOIN entities e ON e.id = k.author_entity_id
     GROUP BY k.author_entity_id ORDER BY count(*) DESC LIMIT 2`,
  ).map((row) => encodeURIComponent(row.key))
  const tags = one<{ id: string }>('SELECT id FROM tags ORDER BY id LIMIT 2')
    .map((row) => row.id)
    .join('%2C')
  const perspectives = one<{ key: string }>(
    `SELECT DISTINCT e.platform || '/' || e.kind || '/' || e.external_id AS key
     FROM follow_edges f JOIN entities e ON e.id = f.follower_id
     ORDER BY key LIMIT 2`,
  ).map((row) => encodeURIComponent(row.key))
  const post = one<{ id: string }>(
    `SELECT collection_id AS id FROM catalog WHERE root_kind = 'x.post'
     ORDER BY collection_id LIMIT 1`,
  )[0]?.id
  const saved = one<{ at: number }>(
    'SELECT created_at AS at FROM library ORDER BY created_at',
  )
  const middle = saved[Math.floor(saved.length / 2)]?.at ?? Date.now()
  const at = (ms: number) => encodeURIComponent(new Date(ms).toISOString())
  const zoned = encodeURIComponent(
    `${new Date(middle + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`,
  )
  const filters = [
    '',
    'q=the+cat',
    'q=OR+-x+%23art+from%3Ame',
    'entity_type=x.post%2Cx.profile%2Cinstagram.post%2Cinstagram.profile',
    'entity_type=instagram.post%2Cinstagram.profile&media_type=image%2Ctext',
    'media_type=image%2Cvideo&visibility=public',
    'sensitive=not_contains&post_type=post',
    'source_state=deleted',
    ...(authors.length
      ? [
          `author=${authors[0]}`,
          `author=${authors.join('&author=')}&media_type=image`,
        ]
      : []),
    ...(tags.includes('%2C')
      ? [`tag=${tags}`, `tag=${tags}&tag_mode=all`, `not_tag=${tags}`]
      : []),
    ...(perspectives.length > 1
      ? [
          `rel=following&rel_of=${perspectives[0]}`,
          `rel=mutual&rel_of=${perspectives.join('&rel_of=')}`,
          `rel=followers&rel_min=1&rel_of=${perspectives.join('&rel_of=')}`,
        ]
      : []),
    ...(post ? [`related_to=${post}`] : []),
    `saved_from=${at(middle)}`,
    `saved_before=${zoned}&sort=saved&order=asc`,
    'saved_within=30d&tz=Asia%2FTokyo',
  ]
  const now = Date.now()
  for (const [i, filter] of filters.entries())
    old.run(sql`INSERT INTO folders (id, name, filter, created_at, updated_at)
      VALUES (${newId()}, ${`verify ${i}`}, ${filter}, ${now}, ${now})`)
  console.info(`added ${filters.length} folders`)
}

const before = new Map<string, { filter: string; members: string[] }>()
for (const row of old.all<{ id: string; filter: string }>(
  sql`SELECT id, filter FROM folders`,
)) {
  const { filter } = parseFilterQuery(row.filter)
  before.set(row.id, { filter: row.filter, members: members(old, filter) })
}
old.$client.close()

// Migrates it, `folder_queries` included.
const db = openDatabase(file)
const types = catalogTypes(db)
let differ = 0
for (const row of db.all<{
  id: string
  name: string
  query: string
  sort: string
  order: string
  tz: string
}>(sql`SELECT id, name, query, sort, "order", tz FROM folders`)) {
  const was = before.get(row.id)!
  const selection = folderSelection(db, types, row)
  const now = members(db, selection.filter, selection.extra)
  const count = countCollections(
    db,
    selection.filter,
    undefined,
    selection.extra,
  ).count
  const same =
    now.length === was.members.length &&
    now.every((id, i) => id === was.members[i]) &&
    count === now.length
  if (!same) differ++
  console.log(
    [
      same ? 'same   ' : 'DIFFERS',
      String(was.members.length).padStart(6),
      String(now.length).padStart(6),
      selection.extra ? 'query ' : 'filter',
      `${row.name}: ${was.filter || '(all)'} → ${row.query || '(all)'}${
        row.sort ? ` sort=${row.sort}` : ''
      }${row.order ? ` order=${row.order}` : ''}${row.tz ? ` tz=${row.tz}` : ''}`,
    ].join('  '),
  )
}
console.log(
  differ
    ? `${differ} of ${before.size} folders differ`
    : `all ${before.size} folders select the same`,
)
process.exitCode = differ ? 1 : 0
