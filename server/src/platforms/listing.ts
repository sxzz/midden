import { Buffer } from 'node:buffer'
import type { FetchResponse } from './protocol.ts'

/** A listed entry as far as the date stop is concerned. */
export interface ListedEntry {
  listedAt?: string
  pinned?: boolean
}

/**
 * Whether a newest-first listing page has moved past a date cutoff, so later
 * pages hold only older entries: its last entry with a known listing time is
 * older than the cutoff. Pinned entries sit at the top out of date order and
 * do not count; entries of unknown time do not either, so a page without any
 * known time never stops the paging. Looking at the last entry rather than
 * any one lets a page that crosses the cutoff stop, while an old entry out of
 * order higher up does not.
 */
export function pastCutoff(
  entries: readonly ListedEntry[],
  since: string,
): boolean {
  const cutoff = Date.parse(since)
  if (Number.isNaN(cutoff)) return false
  for (let i = entries.length - 1; i >= 0; i--) {
    const { listedAt, pinned } = entries[i]!
    if (pinned || !listedAt) continue
    const time = Date.parse(listedAt)
    if (Number.isNaN(time)) continue
    return time < cutoff
  }
  return false
}

/**
 * Where a profile's data keeps the posts pinned to the top of its timeline:
 * their platform ids, in the order listed, empty when none is pinned. A
 * capture that could not tell leaves it out, which reads as not known
 * rather than as unpinned.
 */
export const PINNED_POSTS = '/metadata/pinned_posts'

/** Record the pinned posts a profile's timeline showed on its root entity. */
export function recordPinnedPosts(
  result: FetchResponse,
  ids: readonly string[],
): void {
  const root = result.graph?.entities.find((e) => e.key === result.graph!.root)
  if (!root) return
  const data = JSON.parse(Buffer.from(root.dataJson).toString())
  if (!data || typeof data !== 'object') return
  data.metadata = { ...data.metadata, pinned_posts: [...new Set(ids)] }
  // A new buffer: the entity may share its old one with a cached response.
  root.dataJson = Buffer.from(JSON.stringify(data))
}
