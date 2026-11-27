import type { Tag } from './api'
import type { Rel } from './relation-filter'
import type { ComputedRef, InjectionKey, Ref, WritableComputedRef } from 'vue'

/**
 * What the sidebar's 筛选 card (FilterCard) shows and changes: the list's
 * own filter form and its helpers, provided by CollectionFilters, which
 * keeps the one form behind both the card and the query box. The card
 * changes the form in place and the form applies itself, as the narrow
 * panel's controls do.
 */
export interface FilterCardContext {
  form: {
    postType: string
    media: string[]
    authors: string[]
    tag: string[]
    notTag: string[]
    tagMode: string
    relOf: string[]
    rel: Rel | ''
    relMin: number
    platform: string
    visibility: string
    sensitive: string
    sourceState: string
    from: string
    to: string
    sort: string
    order: string
  }
  /** A list of posts rather than accounts. */
  posts: ComputedRef<boolean>
  /** Behind a public link: none of the owner's own filters. */
  shared: boolean
  withinProfile: ComputedRef<boolean>
  searching: Ref<boolean>
  orderNames: ComputedRef<{ desc: string; asc: string }>
  tags: Ref<Tag[]>
  tagError: Ref<string>
  loadTags: () => void
  managing: Ref<boolean>
  toggleManaging: () => void
  editTag: (tag: Tag) => void
  authors: {
    options: ComputedRef<{ value: string; label: string; detail?: string }[]>
    names: Ref<Record<string, string>>
    loading: Ref<boolean>
    more: ComputedRef<boolean>
    error: Ref<string>
    open: () => void
    search: (query: string) => void
    load: (more?: boolean) => void
  }
  mediaOptions: { value: string; label: string }[]
  range: WritableComputedRef<string>
  rangeOptions: ComputedRef<{ value: string; label: string }[]>
  sourceStateNames: ComputedRef<Record<string, string>>
  relationSummary: Ref<string>
  /** Anything to reset. */
  clearable: ComputedRef<boolean>
  clear: () => void
  /** The list's count, as the column would say it. */
  total: ComputedRef<string>
  /** Open the query box's syntax help. */
  openHelp: () => void
}

export const FILTER_CARD: InjectionKey<FilterCardContext> = Symbol('filters')
