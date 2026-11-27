// The worker keeps the progress of updates (`progress.ts`) and checks some of
// it against a full count now and then, finished updates among them: a few
// updates picked at random each time, so that all are looked at in the end.
// What differs is logged, and the update is kept from scratch again.
import { sql } from 'drizzle-orm'
import { rebuildProgress, settleProgress } from './progress.ts'
import { verifyProgress } from './updates.ts'
import type { CaptureContext } from './context.ts'

/** How many updates one check looks at. */
const SAMPLE = 2

/** Check a few updates; returns the ones that did not match (and were kept again). */
export function checkProgress(ctx: CaptureContext, sample = SAMPLE): string[] {
  const { db } = ctx
  const ids = db
    .all<{ id: string }>(
      sql`SELECT update_id AS id FROM update_progress ORDER BY random() LIMIT ${sample}`,
    )
    .map((row) => row.id)
  const wrong: string[] = []
  for (const id of ids) {
    // In one transaction, so that nothing written meanwhile shows as a
    // difference: what was written before is settled first.
    const problems = db.transaction((tx) => {
      settleProgress(tx)
      const found = verifyProgress(tx, id)
      if (found.length) rebuildProgress(tx, id)
      return found
    })
    if (!problems.length) continue
    ctx.logger.error({ update: id, problems }, 'update progress mismatch')
    wrong.push(id)
  }
  return wrong
}
