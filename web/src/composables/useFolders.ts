import { shallowRef } from 'vue'
import { call, client, errorText, type Folder } from '../api'

/** The saved folders (收藏夹) with their counts, and changes to them. */
export function useFolders() {
  const folders = shallowRef<Folder[]>([])
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
   * A tag merged into another: the server moved the folders filtering on it
   * along, so they read the same here until the next load says so too.
   */
  function retag(from: string, to: string) {
    folders.value = folders.value.map((folder) => {
      const filter = new URLSearchParams(folder.filter)
      if (filter.get('tag') !== from) return folder
      filter.set('tag', to)
      return { ...folder, filter: filter.toString() }
    })
  }
  return { folders, loaded, error, load, create, update, remove, retag }
}
