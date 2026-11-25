import { shallowRef } from 'vue'
import { isProfileEntity } from './relations'
import type { Collection } from './api'

/** What a collection is, as its page and the links to it name it. */
export type DetailKind = 'post' | 'profile'

/** The same words as the library's 帖子 and 账号 lists. */
export const detailTitles: Record<DetailKind, string> = {
  post: '帖子',
  profile: '账号',
}

/**
 * A collection's kind: an account when its root entity is a profile, else a
 * post, as its page shows it.
 */
export function collectionKind(
  collection?: Pick<Collection, 'graph'>,
): DetailKind | undefined {
  if (!collection) return undefined
  const graph = collection.graph
  const root = graph?.entities.find((entity) => entity.key === graph.root)
  return isProfileEntity(root) ? 'profile' : 'post'
}

/**
 * Kinds of the collections whose pages were opened, so the frame around a
 * page (its title) knows what it shows once the page has loaded it.
 */
const known = shallowRef<ReadonlyMap<string, DetailKind>>(new Map())

export function rememberKind(collection: Collection) {
  const kind = collectionKind(collection)
  if (!kind || known.value.get(collection.id) === kind) return
  known.value = new Map(known.value).set(collection.id, kind)
}

/** A collection's kind, from the copy at hand or the page that loaded it. */
export function kindOf(id: string, collection?: Pick<Collection, 'graph'>) {
  return collectionKind(collection) ?? known.value.get(id)
}

/**
 * A collection page's title: 帖子 or 账号. Until the page has loaded what it
 * shows, none.
 */
export function detailTitle(
  id: string,
  collection?: Pick<Collection, 'graph'>,
) {
  const kind = kindOf(id, collection)
  return kind ? detailTitles[kind] : ''
}

/** The browser tab's title: the page's, then the app's name. */
export function setDocumentTitle(title: string) {
  document.title = title ? `${title} · Midden` : 'Midden'
}
