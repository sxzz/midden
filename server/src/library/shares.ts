import { randomBytes } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { folders, library, shares } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import {
  catalogTypes,
  folderSelection,
  type FolderSelection,
} from './folder-query.ts'
import { isUUID } from './read.ts'
import { collectionScope, folderScope, type ShareScope } from './share-scope.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Types } from '#query/compile.ts'

export type ShareTarget = 'folder' | 'collection'

/** A public link as its owner sees it. */
export interface Share {
  id: string
  /** The public address: random, or set by the owner. */
  slug: string
  target: ShareTarget
  target_id: string
  /** The folder's name, for a folder. */
  name?: string
  created_at: string
}

/** 18 random bytes: 144 bits, 24 characters of base64url. */
const SLUG_BYTES = 18
const RANDOM_SLUG = /^[\w-]{24}$/
/**
 * A slug the owner picks: lowercase letters, digits and `-`, 3 to 64 long,
 * starting and ending with a letter or digit. Guessable by design.
 */
const CUSTOM_SLUG = /^[a-z\d][a-z\d-]{1,62}[a-z\d]$/

const isSlug = (slug: string) =>
  RANDOM_SLUG.test(slug) || CUSTOM_SLUG.test(slug)

type Row = typeof shares.$inferSelect

function view(row: Row, name?: string): Share {
  return {
    id: row.id,
    slug: row.slug,
    target: row.targetKind,
    target_id: row.targetId,
    ...(name === undefined ? {} : { name }),
    created_at: row.createdAt.toISOString(),
  }
}

function folderRow(db: Executor, id: string) {
  return isUUID(id)
    ? db.select().from(folders).where(eq(folders.id, id)).get()
    : undefined
}

function isSaved(db: Executor, id: string): boolean {
  return (
    isUUID(id) &&
    !!db
      .select({ id: library.collectionId })
      .from(library)
      .where(eq(library.collectionId, id))
      .get()
  )
}

/** Whether the target still exists: a folder, or a collection still saved. */
function targetExists(db: Executor, row: Row): boolean {
  return row.targetKind === 'folder'
    ? !!folderRow(db, row.targetId)
    : isSaved(db, row.targetId)
}

const active = () => isNull(shares.revokedAt)

/** Whether a live link uses this slug. */
function slugTaken(db: Executor, slug: string): boolean {
  return !!db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.slug, slug), active()))
    .get()
}

/**
 * A random slug no live link uses. It never has the custom form (about one
 * in 500 000 would), so the two kinds of slug tell themselves apart.
 */
function randomSlug(db: Executor): string {
  for (;;) {
    const slug = randomBytes(SLUG_BYTES).toString('base64url')
    if (!CUSTOM_SLUG.test(slug) && !slugTaken(db, slug)) return slug
  }
}

/**
 * Share a folder or a saved collection. A target has at most one live link:
 * sharing it again returns that link.
 */
export function createShare(
  db: Database,
  input: { target: ShareTarget; id: string },
): Share {
  if (
    input.target === 'folder'
      ? !folderRow(db, input.id)
      : !isSaved(db, input.id)
  )
    throw new AppError('not_found')
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(shares)
      .where(
        and(
          eq(shares.targetKind, input.target),
          eq(shares.targetId, input.id),
          active(),
        ),
      )
      .get()
    const row =
      existing ??
      tx
        .insert(shares)
        .values({
          id: newId(),
          slug: randomSlug(tx),
          targetKind: input.target,
          targetId: input.id,
        })
        .returning()
        .get()
    return view(
      row,
      input.target === 'folder' ? folderRow(tx, input.id)?.name : undefined,
    )
  })
}

/** Every live link, oldest first. */
function activeShares(db: Executor): Share[] {
  return db
    .select({ share: shares, name: folders.name })
    .from(shares)
    .leftJoin(
      folders,
      and(eq(shares.targetKind, 'folder'), eq(folders.id, shares.targetId)),
    )
    .where(active())
    .orderBy(asc(shares.createdAt), asc(shares.id))
    .all()
    .filter(({ share }) => targetExists(db, share))
    .map(({ share, name }) => view(share, name ?? undefined))
}

/**
 * Live links, or only those that make this collection public: its own,
 * a folder that holds it, a shared profile listing it.
 */
export function listShares(
  db: Executor,
  collection?: string,
  types: Types = catalogTypes(db),
): Share[] {
  const all = activeShares(db)
  if (collection === undefined) return all
  if (!isUUID(collection)) return []
  return all.filter(
    (share) =>
      scopeOf(db, share.target, share.target_id, types)?.contains([collection])
        .size,
  )
}

/** Stop a link; its address reads as never having existed. */
export function revokeShare(db: Executor, id: string): void {
  const row = isUUID(id)
    ? db
        .update(shares)
        .set({ revokedAt: new Date() })
        .where(and(eq(shares.id, id), active()))
        .returning()
        .get()
    : undefined
  if (!row) throw new AppError('not_found')
}

/**
 * Give a live link another slug, or a new random one when `slug` is null.
 * The old slug stops working at once; there are no aliases. A slug another
 * live link uses is a conflict; one only revoked or replaced links used is
 * free again.
 */
export function setShareSlug(
  db: Database,
  id: string,
  slug: string | null,
): Share {
  if (slug !== null && !CUSTOM_SLUG.test(slug))
    throw new AppError('invalid_slug')
  return db.transaction((tx) => {
    const row = isUUID(id)
      ? tx
          .select()
          .from(shares)
          .where(and(eq(shares.id, id), active()))
          .get()
      : undefined
    if (!row || !targetExists(tx, row)) throw new AppError('not_found')
    let next = row
    if (slug !== row.slug) {
      if (slug !== null && slugTaken(tx, slug))
        throw new AppError('conflict', '这个链接已被其他公开分享使用')
      next = tx
        .update(shares)
        .set({ slug: slug ?? randomSlug(tx) })
        .where(eq(shares.id, row.id))
        .returning()
        .get()!
    }
    return view(
      next,
      next.targetKind === 'folder'
        ? folderRow(tx, next.targetId)?.name
        : undefined,
    )
  })
}

/**
 * Stop the links of folders and collections that are gone, so saving the
 * collection again later does not bring an old address back.
 */
export function revokeOrphanedShares(db: Executor): void {
  db.run(sql`UPDATE shares SET revoked_at = ${Date.now()}
    WHERE revoked_at IS NULL AND (
      (target_kind = 'folder'
        AND target_id NOT IN (SELECT id FROM folders))
      OR (target_kind = 'collection'
        AND target_id NOT IN (SELECT collection_id FROM library)))`)
}

function scopeOf(
  db: Executor,
  target: ShareTarget,
  id: string,
  types: Types,
): ShareScope | undefined {
  if (target === 'collection') return collectionScope(db, id)
  const folder = folderRow(db, id)
  return folder
    ? folderScope(db, folderSelection(db, types, folder))
    : undefined
}

/** A live link as the public reads it. */
export interface OpenShare {
  target: ShareTarget
  target_id: string
  /** The folder's name, for a folder. */
  name?: string
  /** What the folder's query selects, for a folder. */
  selection?: FolderSelection
  scope: ShareScope
}

/**
 * The live link behind a slug. A malformed, unknown or revoked slug, or one
 * whose target is gone, is simply not found.
 */
export function openShare(
  db: Executor,
  slug: string,
  types: Types = catalogTypes(db),
): OpenShare {
  const row = isSlug(slug)
    ? db
        .select()
        .from(shares)
        .where(and(eq(shares.slug, slug), active()))
        .get()
    : undefined
  if (!row || !targetExists(db, row)) throw new AppError('not_found')
  const folder =
    row.targetKind === 'folder' ? folderRow(db, row.targetId) : undefined
  const selection = folder ? folderSelection(db, types, folder) : undefined
  return {
    target: row.targetKind,
    target_id: row.targetId,
    ...(folder ? { name: folder.name, selection } : {}),
    scope: selection
      ? folderScope(db, selection)
      : collectionScope(db, row.targetId),
  }
}
