// Finished capture records, kept between the web app's polls on the read
// threads. The records page polls every few seconds while anything runs,
// and each record's progress is counted over all of its members (thousands
// for an update or a profile's pages): finished records would be counted
// again and again for an answer that no longer changes.
//
// A finished record changes again only when someone acts on it (a retry,
// continuing a profile's posts, stopping), which is a write request to the
// web process: it tells the threads to forget what they keep (`forget`,
// `#reads/pool.ts`). Each entry also carries a stamp of its own rows (the
// record's state, its update's position), so a change there is seen at
// once, and lives at most `TTL` for what changes it in the background
// (maintenance deleting what a record captured).

/** How long a finished record is kept. */
export const TTL = 60_000
const MAX = 500

let enabled = false
const entries = new Map<string, { stamp: string; at: number; value: unknown }>()

/** Keep finished records from now on: on a read thread. */
export function keepFinishedRecords(on = true): void {
  enabled = on
  entries.clear()
}

/** Forget every record kept: something was written. */
export function forgetRecords(): void {
  entries.clear()
}

/** The record kept for `id` with this stamp, if fresh. */
export function keptRecord<T>(
  id: string,
  stamp: string,
  now = Date.now(),
): T | undefined {
  if (!enabled) return
  const entry = entries.get(id)
  if (!entry) return
  if (entry.stamp !== stamp || now - entry.at > TTL) {
    entries.delete(id)
    return
  }
  return entry.value as T
}

/** Keep a finished record, the oldest going first past `MAX`. */
export function keepRecord(
  id: string,
  stamp: string,
  value: unknown,
  now = Date.now(),
): void {
  if (!enabled) return
  entries.delete(id)
  entries.set(id, { stamp, at: now, value })
  if (entries.size > MAX) entries.delete(entries.keys().next().value!)
}
