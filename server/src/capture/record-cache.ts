// Capture records, kept between the web app's polls on the read threads.
// The records page polls every few seconds while anything runs, and each
// record's progress is counted over all of its members (thousands for an
// update or a profile's pages): the same records would be counted again and
// again for an answer that hardly changes.
//
// A finished record changes again only when someone acts on it (a retry,
// continuing a profile's posts, stopping), which is a write request to the
// web process: it tells the threads to forget what they keep (`forget`,
// `#reads/pool.ts`). Each entry also carries a stamp of its own rows (the
// record's state, its update's position), so a change there is seen at
// once, and lives at most `TTL` for what changes it in the background
// (maintenance deleting what a record captured).
//
// A record still in progress is kept too, for `RUNNING_TTL`: a big update's
// members would be counted again on every poll otherwise (about 50 ms per
// 12,000 members). Its numbers may lag by up to that long. The same writes
// forget it, and it is compared by the state of its own rows only, not by
// its position, which moves with every item. A read thread answers one
// request at a time and counts synchronously, so a record is counted by
// one request at a time: a request that comes later finds what the first
// kept (a single flight without any bookkeeping).

/** How long a finished record is kept. */
export const TTL = 60_000
/** How long a record in progress is kept: its numbers lag by up to this. */
export const RUNNING_TTL = 5000
const MAX = 500

let enabled = false
const entries = new Map<
  string,
  { stamp: string; at: number; ttl: number; value: unknown }
>()

/** Keep records from now on: on a read thread. */
export function keepFinishedRecords(on = true): void {
  enabled = on
  entries.clear()
}

/** Forget every record kept: something was written. */
export function forgetRecords(): void {
  entries.clear()
}

/**
 * The record kept for `id` with this stamp, if fresh. A record kept while
 * in progress is compared with `runningStamp` (`stamp` by default).
 */
export function keptRecord<T>(
  id: string,
  stamp: string,
  runningStamp = stamp,
  now = Date.now(),
): T | undefined {
  if (!enabled) return
  const entry = entries.get(id)
  if (!entry) return
  const expected = entry.ttl === RUNNING_TTL ? runningStamp : stamp
  if (entry.stamp !== expected || now - entry.at > entry.ttl) {
    entries.delete(id)
    return
  }
  return entry.value as T
}

/**
 * Keep a record, the oldest going first past `MAX`. One in progress
 * (`running`) is kept for `RUNNING_TTL`; `stamp` is then the stamp it is
 * compared with while in progress.
 */
export function keepRecord(
  id: string,
  stamp: string,
  value: unknown,
  running = false,
  now = Date.now(),
): void {
  if (!enabled) return
  entries.delete(id)
  entries.set(id, { stamp, at: now, ttl: running ? RUNNING_TTL : TTL, value })
  if (entries.size > MAX) entries.delete(entries.keys().next().value!)
}
