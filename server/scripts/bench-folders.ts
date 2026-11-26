// Time what `/v1/folders` does on a copy of a real database: every folder's
// counts with a cold cache, one filter at a time and together, and check that
// the two agree.
//
//   node scripts/bench-folders.ts <db>
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { openDatabase } from '#db/client.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import {
  countCollections,
  countCollectionsTogether,
  sharesCountPass,
} from '#library/list.ts'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-folders.ts <db>')
  process.exit(2)
}
const db = openDatabase(file, { migrate: false })
const tag = (
  db.$client.prepare('SELECT id FROM tags ORDER BY id').get() as
    { id: string } | undefined
)?.id
const queries = [
  '',
  'entity_type=x.post,x.profile',
  'entity_type=x.post,x.profile&media_type=video',
  'entity_type=x.post,x.profile&media_type=image&sort=published',
  'entity_type=x.post,x.profile&media_type=text',
  'sensitive=contains',
  'visibility=private',
  'visibility=public&media_type=image',
  'saved_within=7d',
  'saved_within=30d&media_type=video',
  'post_type=repost',
  'post_type=quote',
  'q=天气',
  'q=release&media_type=image',
  ...(tag ? [`entity_type=x.post,x.profile&tag=${tag}`, `not_tag=${tag}`] : []),
]
const filters = queries.map((q) => parseFilterQuery(q).filter)

const each: ReturnType<typeof countCollections>[] = []
let at = performance.now()
for (const filter of filters) {
  const started = performance.now()
  each.push(countCollections(db, filter))
  console.log(
    `${(performance.now() - started).toFixed(1).padStart(8)} ms  ${String(each.at(-1)!.count).padStart(6)}  ${queries[each.length - 1] || '(all)'}`,
  )
}
const alone = performance.now() - at
at = performance.now()
const sharing = filters.filter((f) => sharesCountPass(f))
const counted = countCollectionsTogether(db, sharing)
const together = filters.map((f) => {
  const i = sharing.indexOf(f)
  return i === -1 ? countCollections(db, f) : counted[i]!
})
const shared = performance.now() - at
console.log(
  `${queries.length} filters: ${alone.toFixed(0)} ms one by one, ${shared.toFixed(0)} ms together`,
)
for (const [i, counts] of together.entries())
  if (JSON.stringify(counts) !== JSON.stringify(each[i]))
    console.log('DIFFERS', queries[i], counts, each[i])
