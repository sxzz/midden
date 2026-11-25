import * as v from 'valibot'
import { AppError } from '#errors.ts'
import { defaultRelMin, tagList, type CollectionFilter } from './list.ts'

const text = v.optional(v.string())

/** Library list filters as query parameters; list.ts checks their values. */
export const FilterQuery = v.object({
  q: text,
  entity_type: text,
  media_type: text,
  visibility: text,
  saved_from: text,
  saved_before: text,
  saved_within: text,
  time_zone: text,
  sort: text,
  order: text,
  author: v.optional(v.union([v.string(), v.array(v.string())])),
  sensitive: text,
  tag: text,
  tag_mode: text,
  not_tag: text,
  related_to: text,
  post_type: text,
  source_state: text,
  rel_of: v.optional(v.union([v.string(), v.array(v.string())])),
  rel: text,
  rel_min: text,
})

export type FilterParams = v.InferOutput<typeof FilterQuery>

/** The filter the list reads from its query parameters. */
export function collectionFilter(input: FilterParams): CollectionFilter {
  const author = input.author ?? []
  const relOf = input.rel_of ?? []
  return {
    q: input.q || undefined,
    entityType: input.entity_type || undefined,
    mediaType: input.media_type || undefined,
    visibility: input.visibility || undefined,
    savedFrom: input.saved_from || undefined,
    savedBefore: input.saved_before || undefined,
    savedWithin: input.saved_within || undefined,
    timeZone: input.time_zone || undefined,
    sort: input.sort || undefined,
    order: input.order || undefined,
    authors: typeof author === 'string' ? [author] : author,
    sensitive: input.sensitive || undefined,
    tag: input.tag || undefined,
    tagMode: input.tag_mode || undefined,
    notTag: input.not_tag || undefined,
    relatedTo: input.related_to || undefined,
    postType: input.post_type || undefined,
    sourceState: input.source_state || undefined,
    relOf: (typeof relOf === 'string' ? [relOf] : relOf).filter(Boolean),
    rel: input.rel || undefined,
    relMin: input.rel_min || undefined,
  }
}

const KEYS = Object.keys(FilterQuery.entries).toSorted()
const SPACES = /\s+/g

/**
 * A list query string as the list endpoint would read it: a repeated key is
 * an array, as Hono passes it to the validator. Keys that are not filters
 * (the page cursor, the web's layout) are left out of the canonical form,
 * which keeps the filter keys in a fixed order and drops empty values, so
 * one filter is always written one way.
 */
export function parseFilterQuery(query: string): {
  filter: CollectionFilter
  canonical: string
} {
  const params = new URLSearchParams(query)
  const raw: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    raw[key] = all.length === 1 ? all[0]! : all
  }
  const parsed = v.safeParse(FilterQuery, raw)
  if (!parsed.success) throw new AppError('invalid_filter')
  // A time zone only matters to a relative save date.
  if (!parsed.output.saved_within) parsed.output.time_zone = undefined
  // Tags are sets; how they match only matters with more than one.
  const output = parsed.output
  // Search splits its terms at any white space.
  output.q = output.q?.trim().replaceAll(SPACES, ' ')
  output.tag = tagList(output.tag)
  output.not_tag = tagList(output.not_tag)
  if (output.tag_mode === 'any' || output.tag.split(',').length < 2)
    output.tag_mode = undefined
  // Perspectives are a set, and the default threshold goes unsaid.
  const relOf = output.rel_of ?? []
  const perspectives = new Set(typeof relOf === 'string' ? [relOf] : relOf)
  perspectives.delete('')
  output.rel_of = [...perspectives]
  if (
    perspectives.size &&
    output.rel_min === String(defaultRelMin(perspectives.size))
  )
    output.rel_min = undefined
  const canonical = new URLSearchParams()
  for (const key of KEYS) {
    const value = parsed.output[key as keyof FilterParams]
    // Any author matches, so their order is not part of the filter; nor
    // is the perspectives'.
    const items = typeof value === 'string' ? [value] : (value ?? []).toSorted()
    for (const item of items) if (item) canonical.append(key, item)
  }
  return {
    filter: collectionFilter(parsed.output),
    canonical: canonical.toString(),
  }
}
