import { and, eq, ne, sql } from 'drizzle-orm'
import { collectionTags, folders, tags } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { checkTagName, type Tag } from './annotations.ts'
import { parseFilterQuery } from './filter-query.ts'
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

/** Folders whose filter is on the tag. Filters hold at most one tag. */
function foldersOn(tx: Transaction, id: string) {
  return tx
    .select()
    .from(folders)
    .all()
    .filter((folder) => new URLSearchParams(folder.filter).get('tag') === id)
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
    for (const folder of foldersOn(tx, id)) {
      const params = new URLSearchParams(folder.filter)
      params.set('tag', into.id)
      tx.update(folders)
        .set({ filter: parseFilterQuery(params.toString()).canonical })
        .where(eq(folders.id, folder.id))
        .run()
    }
    // Its associations go with it; counts by filter are cached until the
    // next write, which this is.
    tx.delete(tags).where(eq(tags.id, id)).run()
    return { tag: into, merged: true, moved: Number(moved) }
  })
}

/**
 * Delete a tag and take it off every collection. A folder filtering on it
 * would silently select more, so the tag stays until no folder uses it.
 */
export function deleteTag(db: Database, id: string): void {
  db.transaction((tx) => {
    find(tx, id)
    const using = foldersOn(tx, id)
    if (using.length)
      throw new AppError(
        'conflict',
        `收藏夹${using.map((f) => `「${f.name}」`).join('、')}按此标签筛选，请先修改收藏夹`,
      )
    tx.delete(tags).where(eq(tags.id, id)).run()
  })
}
