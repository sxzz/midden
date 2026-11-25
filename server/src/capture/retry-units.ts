import { and, eq, sql } from 'drizzle-orm'
import { assets, captures } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import type { Executor } from '#db/client.ts'
import type { Page } from './records.ts'

/**
 * What a record can retry, each part on its own (see `retries.ts`):
 *
 * - a failed capture, captured again: an update's item, or a member of a
 *   timeline page, submitted again by its page;
 * - a capture missing media (`partial` with failed assets): only those
 *   media, downloaded again into the same capture;
 * - a timeline page whose listing was not submitted (`related` failed): its
 *   members and next page, submitted again;
 * - a timeline page whose capture failed: the same page, fetched again in
 *   its place in the chain;
 * - a following or followers list that failed or fell short: fetched again,
 *   from where it stopped when it can.
 *
 * A record's own failed capture is not among them: `重试` captures its
 * target again as a new record. Nothing stopped (中止) is retried.
 */

const finished = (state: string) => state === 'complete' || state === 'partial'

/** SQL: whether capture `c` is missing media a retry would download. */
export const missingMediaSQL = sql`(c.state = 'partial' AND EXISTS (
  SELECT 1 FROM assets x WHERE x.capture_id = c.id AND x.state = 'failed'))`

/** Captures among these missing media a retry would download again. */
export function missingMedia(db: Executor, captureIds: string[]): Set<string> {
  if (!captureIds.length) return new Set()
  return new Set(
    db
      .selectDistinct({ id: assets.captureId })
      .from(assets)
      .innerJoin(captures, eq(captures.id, assets.captureId))
      .where(
        and(
          inJson(assets.captureId, captureIds),
          eq(assets.state, 'failed'),
          eq(captures.state, 'partial'),
        ),
      )
      .all()
      .map((row) => row.id),
  )
}

/**
 * A page whose failed members it can submit again: fetched, not stopped,
 * and its listing submitted or failed to be.
 */
export const isRetryablePage = (page: Page) =>
  !page.submission.collectionStopped &&
  finished(page.capture.state) &&
  (page.submission.relatedState === 'complete' ||
    page.submission.relatedState === 'failed')

export interface FailedPage {
  page: Page
  /** Its place in the chain, from 0. */
  index: number
  /** `related`: its listing was not submitted; `fetch`: it was not fetched. */
  kind: 'related' | 'fetch'
}

/**
 * Pages of a chain to retry. A first page that failed is the record's own
 * capture (or an update's item), retried as such.
 */
export function failedPages(pages: Page[]): FailedPage[] {
  return pages.flatMap((page, index): FailedPage[] => {
    if (page.submission.collectionStopped) return []
    if (
      finished(page.capture.state) &&
      page.submission.relatedState === 'failed'
    )
      return [{ page, index, kind: 'related' }]
    if (index > 0 && page.capture.state === 'failed')
      return [{ page, index, kind: 'fetch' }]
    return []
  })
}

/** Pages after the first that are missing media, by chain. */
export function pagesMissingMedia(
  db: Executor,
  chains: Map<string, Page[]>,
): Map<string, string[]> {
  const later = [...chains.values()].flatMap((pages) =>
    pages.slice(1).map((p) => p.capture.id),
  )
  const missing = missingMedia(db, later)
  return new Map(
    [...chains].map(([root, pages]) => [
      root,
      pages
        .slice(1)
        .map((p) => p.capture.id)
        .filter((id) => missing.has(id)),
    ]),
  )
}

/**
 * Whether a list fetch can be fetched again: it failed or fell short, its
 * profile was fetched, and its request was not stopped.
 */
export const isRetryableList = (
  state: string,
  owner: { captureState: string; stopped: boolean },
) =>
  (state === 'failed' || state === 'partial') &&
  finished(owner.captureState) &&
  !owner.stopped
