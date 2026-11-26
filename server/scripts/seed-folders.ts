// Add a dozen varied folders to a database (a copy, not a live one).
//
//   node scripts/seed-folders.ts <db>
import process from 'node:process'
import { openDatabase } from '#db/client.ts'
import { createFolder } from '#library/folders.ts'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: seed-folders.ts <db>')
  process.exit(2)
}
const db = openDatabase(file, { migrate: false })
const tag = (
  db.$client.prepare('SELECT id FROM tags ORDER BY id').get() as
    { id: string } | undefined
)?.id
const filters = [
  'entity_type=x.post',
  'media_type=video',
  'media_type=image&sort=published',
  'media_type=text',
  'sensitive=contains',
  'visibility=private',
  'saved_within=7d',
  'saved_within=30d&media_type=video',
  'post_type=repost',
  'post_type=quote',
  'q=天气',
  'q=release&media_type=image',
  ...(tag ? [`tag=${tag}`, `not_tag=${tag}`] : []),
]
for (const [i, filter] of filters.entries())
  createFolder(db, { name: `folder ${i}`, filter })
console.log(`created ${filters.length} folders`)
