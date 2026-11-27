import { onActivated, onDeactivated, onUnmounted, shallowRef, watch } from 'vue'
import type { Collection, FollowCounts, HistoryPoint } from './api'

/**
 * What a collection's page has loaded, for the desktop sidebar beside it
 * (SideAside): the sidebar reads it rather than asking the server again.
 */
export interface DetailAside {
  id: string
  collection?: Collection
  savedAt?: string
  follows?: FollowCounts
  /** The newest captures, as the timeline loaded them. */
  points: HistoryPoint[]
  /** Whether there are older captures than `points`. */
  morePoints: boolean
  /** The latest update's record, while it runs or after it ended. */
  record: string
  updating: boolean
  /** Which of the collection's own pages have anything to show. */
  pages: { stats: boolean; changes: boolean; follows: boolean }
  /** A profile's 定期更新: how often, and when it runs next. */
  watch?: { label: string; hint?: string }
  /** 已公开, or the shares it is public through; the owner's only. */
  exposure?: string
  /**
   * What the owner can do from the sidebar, in the page's own sheets: start
   * an update, edit a profile's 定期更新. None behind a public link.
   */
  actions?: {
    update: () => void
    editWatch?: () => void
    /** The update cannot start now (busy, or no capture service). */
    disabled: boolean
  }
}

/** The shown page's context; pages kept alive but hidden have none here. */
export const pageAside = shallowRef<DetailAside>()

/**
 * Publish a page's context while the page is shown: from when it is first
 * shown or shown again until it is hidden, following `source` meanwhile.
 */
export function useAside(source: () => DetailAside | undefined) {
  let shown = true
  let mine: DetailAside | undefined
  const publish = () => {
    mine = source()
    pageAside.value = mine
  }
  const withdraw = () => {
    // Another page may have published since; leave its context alone.
    if (pageAside.value === mine) pageAside.value = undefined
    mine = undefined
  }
  watch(source, () => shown && publish(), { immediate: true })
  onActivated(() => {
    shown = true
    publish()
  })
  onDeactivated(() => {
    shown = false
    withdraw()
  })
  onUnmounted(withdraw)
}
