import * as v from 'valibot'
import { AppError } from '#errors.ts'

/** How a collection (profile) capture expands; inherited by its pages. */
export const CaptureOptions = v.object({
  mediaOnly: v.optional(v.boolean()),
  omitShared: v.optional(v.boolean()),
  skipReferences: v.optional(v.boolean()),
  maxPosts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  since: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  /** Read the timeline without capturing its posts: the profile alone. */
  skipPosts: v.optional(v.boolean()),
  /**
   * Keep paging until a page lists posts already saved, then read one page
   * more: the saved post may only have been someone else's repost or quote.
   */
  untilExisting: v.optional(v.boolean()),
  /** Set on that one page more: no page follows it. */
  finalPage: v.optional(v.boolean()),
})
// eslint-disable-next-line @typescript-eslint/no-redeclare -- schema and type share the name
export type CaptureOptions = v.InferOutput<typeof CaptureOptions>

export const MAX_POSTS = 100_000

export function checkOptions(options: CaptureOptions | undefined): void {
  if (!options) return
  if ((options.maxPosts ?? 0) > MAX_POSTS) throw new AppError('invalid_target')
  if (options.since !== undefined && Number.isNaN(Date.parse(options.since)))
    throw new AppError('invalid_target')
}

export interface ListedTarget {
  publishedAt: string
  mediaTypes: string[]
  postType: string
}

/** Whether a listed member passes the options' filters. */
export function matchesOptions(
  options: CaptureOptions,
  target: ListedTarget,
): boolean {
  if (
    options.omitShared &&
    (target.postType === 'quote' || target.postType === 'repost')
  )
    return false
  if (options.skipReferences && target.postType === 'repost') return false
  if (options.mediaOnly && target.mediaTypes.length === 0) return false
  if (options.since) {
    const published = Date.parse(target.publishedAt)
    if (Number.isNaN(published) || published < Date.parse(options.since))
      return false
  }
  return true
}
