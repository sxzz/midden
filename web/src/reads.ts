import { call, client } from './api'
import { shareSlug } from './share'

// Reads of the library the detail pages share with public links: the
// owner's API, or the open share's public one, which answers the same shapes
// for what the share reaches.

const own = client.collections[':id']
const shared = client.public[':slug'].collections
const at = (id: string) => ({ slug: shareSlug.value, id })
const init = (signal?: AbortSignal) => ({ init: { signal } })

export function readCollection(id: string, signal?: AbortSignal) {
  return call(
    shareSlug.value
      ? shared[':id'].$get({ param: at(id) }, init(signal))
      : own.$get({ param: { id } }, init(signal)),
  )
}

export function readHistory(id: string, cursor = '', signal?: AbortSignal) {
  const query = cursor ? { cursor } : {}
  return call(
    shareSlug.value
      ? shared[':id'].history.$get({ param: at(id), query }, init(signal))
      : own.history.$get({ param: { id }, query }, init(signal)),
  )
}

export function readHistoryPoint(
  id: string,
  capture: string,
  signal?: AbortSignal,
) {
  return call(
    shareSlug.value
      ? shared[':id'].history[':capture'].$get(
          { param: { ...at(id), capture } },
          init(signal),
        )
      : own.history[':capture'].$get({ param: { id, capture } }, init(signal)),
  )
}

export function readCounts(id: string, limit?: number, signal?: AbortSignal) {
  const query = limit ? { limit: String(limit) } : {}
  return call(
    shareSlug.value
      ? shared[':id'].counts.$get({ param: at(id), query }, init(signal))
      : own.counts.$get({ param: { id }, query }, init(signal)),
  )
}

export function readProfileChanges(
  id: string,
  limit?: number,
  signal?: AbortSignal,
) {
  const query = limit ? { limit: String(limit) } : {}
  return call(
    shareSlug.value
      ? shared[':id']['profile-changes'].$get(
          { param: at(id), query },
          init(signal),
        )
      : own['profile-changes'].$get({ param: { id }, query }, init(signal)),
  )
}

export function readFollows(id: string, signal?: AbortSignal) {
  return call(
    shareSlug.value
      ? shared[':id'].follows.$get({ param: at(id) }, init(signal))
      : own.follows.$get({ param: { id } }, init(signal)),
  )
}

export function readFollowChanges(
  id: string,
  limit?: number,
  signal?: AbortSignal,
) {
  const query = limit ? { limit: String(limit) } : {}
  return call(
    shareSlug.value
      ? shared[':id']['follow-changes'].$get(
          { param: at(id), query },
          init(signal),
        )
      : own['follow-changes'].$get({ param: { id }, query }, init(signal)),
  )
}

/**
 * One page of a list for the list's API query. A share lists its folder or a
 * profile's posts, narrowed by the same filters but tags, which it refuses.
 */
export function readList(params: URLSearchParams, signal?: AbortSignal) {
  const query = () => ({
    ...Object.fromEntries(params),
    author: params.getAll('author'),
  })
  if (!shareSlug.value)
    return call(client.collections.$get({ query: query() }, init(signal)))
  params = new URLSearchParams(params)
  params.delete('tag')
  return call(
    client.public[':slug'].collections.$get(
      { param: { slug: shareSlug.value }, query: query() },
      init(signal),
    ),
  )
}

/** Authors for the author filter: within the share when one is open. */
export function readAuthors(
  query: { q?: string; cursor?: string; author?: string[] },
  signal?: AbortSignal,
) {
  return call(
    shareSlug.value
      ? client.public[':slug'].collections.authors.$get(
          { param: { slug: shareSlug.value }, query },
          init(signal),
        )
      : client.collections.authors.$get({ query }, init(signal)),
  )
}

/** What a public link opens. */
export function readShare(slug: string, signal?: AbortSignal) {
  return call(client.public[':slug'].$get({ param: { slug } }, init(signal)))
}
