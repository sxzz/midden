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
