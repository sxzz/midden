import { eq } from 'drizzle-orm'
import { settings } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

/**
 * The owner's pause of background work (管理员面板 → 后台任务), kept in the
 * database so it outlasts restarts and deploys. The worker reads it every
 * time it looks for jobs.
 */
export interface JobControl {
  /** Claim nothing; jobs still enqueue and wait. */
  paused: boolean
  /** Job types not claimed (`PAUSABLE_TYPES`). */
  types: string[]
}

const KEY = 'jobs_control'

export function readJobControl(db: Executor): JobControl {
  const stored = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, KEY))
    .get()?.value
  if (!stored) return { paused: false, types: [] }
  try {
    const parsed = JSON.parse(stored) as Partial<JobControl>
    return {
      paused: parsed.paused === true,
      types: Array.isArray(parsed.types)
        ? parsed.types.filter((t): t is string => typeof t === 'string')
        : [],
    }
  } catch {
    return { paused: false, types: [] }
  }
}

export function writeJobControl(db: Executor, control: JobControl): void {
  const value = JSON.stringify({
    paused: control.paused,
    types: [...new Set(control.types)].toSorted(),
  })
  db.insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}
