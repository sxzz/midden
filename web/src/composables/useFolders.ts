import { shallowRef } from 'vue'
import {
  call,
  client,
  errorText,
  isSaved,
  type Folder,
  type LibraryFolder,
} from '../api'
import { retagQuery } from '../folders'

/**
 * The saved folders (收藏夹) with their counts, and changes to them. A
 * viewer has the publicly shared ones alone, without their queries
 * (`SharedFolder`), and changes none.
 */
export function useFolders() {
  const folders = shallowRef<LibraryFolder[]>([])
  /** Whether a load has finished, successfully or not. */
  const loaded = shallowRef(false)
  const error = shallowRef('')
  let request = 0
  let pending: Promise<void> | undefined
  async function fetchFolders() {
    const version = ++request
    try {
      const data = await call(client.folders.$get())
      if (version !== request) return
      // Anything but a list (a stand-in API) means none.
      folders.value = Array.isArray(data) ? data : []
      error.value = ''
    } catch (e) {
      if (version === request) error.value = errorText(e)
    } finally {
      if (version === request) loaded.value = true
    }
  }
  /** Load the folders; calls while one is running share it. */
  function load() {
    pending ??= fetchFolders().finally(() => (pending = undefined))
    return pending
  }
  function put(folder: Folder) {
    folders.value = folders.value.some((f) => f.id === folder.id)
      ? folders.value.map((f) => (f.id === folder.id ? folder : f))
      : [...folders.value, folder]
  }
  /** These throw the server's error, for the caller to show. */
  async function create(name: string, filter: string) {
    const folder = await call(client.folders.$post({ json: { name, filter } }))
    put(folder)
    return folder
  }
  async function update(
    id: string,
    change: { name?: string; filter?: string },
  ) {
    const folder = await call(
      client.folders[':id'].$patch({ param: { id }, json: change }),
    )
    put(folder)
    return folder
  }
  async function remove(id: string) {
    await call(client.folders[':id'].$delete({ param: { id } }))
    folders.value = folders.value.filter((f) => f.id !== id)
  }
  /**
   * A tag merged into another or deleted: the server rewrote the folders
   * filtering on it, so their filters read the same here until the next
   * load does (which brings their queries).
   */
  function retag(from: string, to?: string) {
    folders.value = folders.value.map((folder) => {
      if (!isSaved(folder) || folder.filter === null) return folder
      const filter = retagQuery(folder.filter, from, to)
      return filter === folder.filter ? folder : { ...folder, filter }
    })
  }
  return { folders, loaded, error, load, create, update, remove, retag }
}
