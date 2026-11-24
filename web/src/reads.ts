import { call, client } from './api'
import { RELATION_KEYS } from './relation-filter'
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
 * A profile's follow graph: the accounts of `kinds` (all when absent), the
 * `limit` with the most followers.
 */
export function readGraph(
  id: string,
  options: { kinds?: readonly string[]; limit?: number; viewer?: string } = {},
  signal?: AbortSignal,
) {
  const query: Record<string, string> = {}
  if (options.kinds) query.kinds = options.kinds.join(',')
  if (options.limit) query.limit = String(options.limit)
  // Whose follows mark the nodes is the owner's alone.
  if (shareSlug.value)
    return call(
      shared[':id'].graph.$get({ param: at(id), query }, init(signal)),
    )
  if (options.viewer) query.viewer = options.viewer
  return call(own.graph.$get({ param: { id }, query }, init(signal)))
}

/** Several accounts' relations side by side; the owner's alone. */
export function readCompare(
  query: {
    rel_of: string[]
    rel: 'following' | 'followers'
    rel_min?: number
    only?: readonly number[]
    limit?: number
    viewer?: string
  },
  signal?: AbortSignal,
) {
  return call(
    client.collections.compare.$get(
      {
        query: {
          rel_of: query.rel_of,
          rel: query.rel,
          ...(query.rel_min ? { rel_min: String(query.rel_min) } : {}),
          ...(query.only ? { only: query.only.join(',') } : {}),
          ...(query.limit ? { limit: String(query.limit) } : {}),
          ...(query.viewer ? { viewer: query.viewer } : {}),
        },
      },
      init(signal),
    ),
  )
}

/** A list's API query for the client: repeated keys stay lists. */
export function listQuery(params: URLSearchParams) {
  return {
    ...Object.fromEntries(params),
    author: params.getAll('author'),
    rel_of: params.getAll('rel_of'),
  }
}

/**
 * One page of a list for the list's API query. A share lists its folder or a
 * profile's posts, narrowed by the same filters but tags, save dates and
 * follows, which it refuses.
 */
export function readList(params: URLSearchParams, signal?: AbortSignal) {
  return call(
    shareSlug.value
      ? client.public[':slug'].collections.$get(
          { param: { slug: shareSlug.value }, query: publicQuery(params) },
          init(signal),
        )
      : client.collections.$get({ query: listQuery(params) }, init(signal)),
  )
}

/** How much a list holds over all its pages, for the same query. */
export function readCount(params: URLSearchParams, signal?: AbortSignal) {
  params = new URLSearchParams(params)
  params.delete('cursor')
  return call(
    shareSlug.value
      ? client.public[':slug'].collections.count.$get(
          { param: { slug: shareSlug.value }, query: publicQuery(params) },
          init(signal),
        )
      : client.collections.count.$get(
          { query: listQuery(params) },
          init(signal),
        ),
  )
}

/** A list's query as a share takes it, without the filters it refuses. */
function publicQuery(params: URLSearchParams) {
  params = new URLSearchParams(params)
  for (const key of [
    'tag',
    'tag_mode',
    'not_tag',
    'saved_from',
    'saved_before',
    'saved_within',
    'time_zone',
    ...RELATION_KEYS,
  ])
    params.delete(key)
  return { ...Object.fromEntries(params), author: params.getAll('author') }
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
