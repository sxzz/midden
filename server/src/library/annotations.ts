import { asc, eq, inArray, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { collectionTags, library, tags } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Database, Executor, Transaction } from '#db/client.ts'

export interface Tag {
  id: string
  name: string
}

export interface Annotation {
  note: string
  tags: Tag[]
}

export interface AnnotationUpdate {
  note?: string
  tagIds?: string[]
  tagNames?: string[]
}

const MAX_NOTE = 10_000
const MAX_TAGS = 100
const MAX_TAG_NAME = 64
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

const runes = (value: string) => [...value].length

export function listTags(db: Executor): Tag[] {
  return db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .orderBy(asc(tags.name), asc(tags.id))
    .all()
}

/** Tags nothing uses any more go away. */
export function pruneTags(tx: Transaction): void {
  tx.delete(tags)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${collectionTags} WHERE ${collectionTags.tagId} = ${tags.id})`,
    )
    .run()
}

export function readAnnotation(db: Executor, collectionId: string): Annotation {
  const saved = db
    .select({ note: library.note })
    .from(library)
    .where(eq(library.collectionId, collectionId))
    .get()
  if (!saved) throw new AppError('not_found')
  return {
    note: saved.note,
    tags: db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .innerJoin(collectionTags, eq(collectionTags.tagId, tags.id))
      .where(eq(collectionTags.collectionId, collectionId))
      .orderBy(asc(tags.name), asc(tags.id))
      .all(),
  }
}

function validate(update: AnnotationUpdate): void {
  const invalid = () => new AppError('invalid_annotation')
  if (
    update.note !== undefined &&
    (runes(update.note) > MAX_NOTE || update.note.includes('\0'))
  )
    throw invalid()
  if (update.tagNames !== undefined) {
    if (update.tagIds !== undefined || update.tagNames.length > MAX_TAGS)
      throw invalid()
    for (const name of update.tagNames) {
      const trimmed = name.trim()
      if (!trimmed || runes(trimmed) > MAX_TAG_NAME || trimmed.includes('\0'))
        throw invalid()
    }
  }
  if (
    update.tagIds !== undefined &&
    (update.tagIds.length > MAX_TAGS ||
      update.tagIds.some((id) => !UUID.test(id)))
  )
    throw invalid()
}

/** Change a saved collection's note and/or replace its tags, atomically. */
export function updateAnnotation(
  db: Database,
  collectionId: string,
  update: AnnotationUpdate,
): Annotation {
  validate(update)
  return db.transaction((tx) => {
    readAnnotation(tx, collectionId)
    if (update.note !== undefined)
      tx.update(library)
        .set({ note: update.note })
        .where(eq(library.collectionId, collectionId))
        .run()
    let ids = update.tagIds
    if (update.tagNames !== undefined) {
      ids = []
      for (const name of new Set(update.tagNames.map((n) => n.trim()))) {
        tx.insert(tags)
          .values({ id: newId(), name })
          .onConflictDoNothing()
          .run()
        ids.push(
          tx
            .select({ id: tags.id })
            .from(tags)
            .where(eq(tags.name, name))
            .get()!.id,
        )
      }
    }
    if (ids !== undefined) {
      const unique = [...new Set(ids)]
      const found = unique.length
        ? tx
            .select({ id: tags.id })
            .from(tags)
            .where(inArray(tags.id, unique))
            .all()
        : []
      if (found.length !== unique.length) throw new AppError('not_found')
      tx.delete(collectionTags)
        .where(eq(collectionTags.collectionId, collectionId))
        .run()
      for (const tagId of unique)
        tx.insert(collectionTags).values({ collectionId, tagId }).run()
      pruneTags(tx)
    }
    return readAnnotation(tx, collectionId)
  })
}
