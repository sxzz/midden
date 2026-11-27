import { and, eq, ne, sql } from 'drizzle-orm'
import { collectionTags, tags } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { checkTagName, type Tag } from './annotations.ts'
import { dropExcludedWanted, rewriteFolderQueries } from './folder-query.ts'
import type { Database, Transaction } from '#db/client.ts'

export interface TagRename {
  /** The tag under its new name; the one merged into when `merged`. */
  tag: Tag
  /** Whether another tag already had the name and took this one's place. */
  merged: boolean
  /** Collections the merge tagged that did not carry the surviving tag. */
  moved: number
}

function find(tx: Transaction, id: string): Tag {
  const tag = tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.id, id))
    .get()
  if (!tag) throw new AppError('not_found')
  return tag
}

/**
 * Point every folder query that names the tag at `into` instead, or drop
 * it when there is none (from its AND, its OR, its `-`).
 */
function rewriteFolders(tx: Transaction, id: string, into?: string) {
  rewriteFolderQueries(tx, (leaf) => {
    if (leaf.type !== 'atom' || leaf.key !== 'tag' || leaf.value !== id) return
    return into ? { ...leaf, value: into } : null
  })
  // A merge that leaves a tag both wanted and excluded: wanting it wins,
  // the folder was about it.
  if (into) dropExcludedWanted(tx, into)
}

/**
 * Rename a tag. Filters and folders name tags by id, so they keep working.
 * When another tag has the name already, the two become one: the other
 * tag survives, takes this one's collections and folders, and this one
 * goes away.
 */
export function renameTag(db: Database, id: string, raw: string): TagRename {
  const name = checkTagName(raw, 'invalid_tag')
  return db.transaction((tx) => {
    find(tx, id)
    const into = tx
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.name, name), ne(tags.id, id)))
      .get()
    if (!into) {
      tx.update(tags).set({ name }).where(eq(tags.id, id)).run()
      return { tag: { id, name }, merged: false, moved: 0 }
    }
    const moved = tx
      .insert(collectionTags)
      .select(
        tx
          .select({
            collectionId: collectionTags.collectionId,
            tagId: sql<string>`CAST(${into.id} AS TEXT)`.as('tag_id'),
          })
          .from(collectionTags)
          .where(eq(collectionTags.tagId, id)),
      )
      .onConflictDoNothing()
      .run().changes
    rewriteFolders(tx, id, into.id)
    // Its associations go with it; counts by filter are cached until the
    // next write, which this is.
    tx.delete(tags).where(eq(tags.id, id)).run()
    return { tag: into, merged: true, moved: Number(moved) }
  })
}

/**
 * Delete a tag, take it off every collection and out of every folder
 * filter that names it.
 */
export function deleteTag(db: Database, id: string): void {
  db.transaction((tx) => {
    find(tx, id)
    rewriteFolders(tx, id)
    tx.delete(tags).where(eq(tags.id, id)).run()
  })
}
