import * as v from 'valibot'
import { AppError } from '#errors.ts'
import type { CaptureContext } from './context.ts'

/**
 * How much of a profile's timeline a capture reads:
 * - `none`: the profile alone;
 * - `latest`: its newest `count` posts as listed, filtered or not;
 * - `until_existing`: pages until one lists a post saved before, then one
 *   page more, at most `TIMELINE_CAP` posts (continuable);
 * - `max`: until `count` posts pass the filters, or all of them.
 */
export const postModes = ['none', 'latest', 'until_existing', 'max'] as const
export type PostMode = (typeof postModes)[number]

/** Relative date ranges (发帖日期), in days. */
export const sinceDays = [1, 7, 30, 90, 365] as const

export const MAX_POSTS = 100_000
export const DEFAULT_LATEST = 100
/**
 * Timeline posts `until_existing` reads per profile, per run or per
 * continuation of one: a profile never captured has no saved posts to stop at.
 */
export const TIMELINE_CAP = 1000

/**
 * What a capture or an update does, the same for both. Profiles use all of
 * it; a single post only `captureReferences`.
 */
export interface CaptureOptions {
  posts: PostMode
  /** `latest`: how many; `max`: at most how many, none for all. */
  count?: number
  /** Only posts published in the last this many days. */
  sinceDays?: (typeof sinceDays)[number]
  mediaOnly: boolean
  /** Keep quotes and pure reposts. */
  includeShared: boolean
  /** Capture the posts quotes and reposts refer to. */
  captureReferences: boolean
  /** Also fetch the following and followers lists (抓关系网). */
  relations: boolean
}

/** As stored on each submission: resolved once, inherited by its pages. */
export interface StoredOptions extends CaptureOptions {
  /** The cutoff `sinceDays` named when the run started. */
  since?: string
  /** `until_existing` found saved posts: this page is its last. */
  finalPage?: boolean
}

export const DEFAULT_OPTIONS: CaptureOptions = Object.freeze({
  posts: 'latest',
  count: DEFAULT_LATEST,
  mediaOnly: false,
  includeShared: true,
  captureReferences: true,
  relations: false,
})

/** The request body both `/captures` and `/updates` take; all optional. */
export const OptionsBody = v.strictObject({
  posts: v.optional(v.picklist(postModes)),
  count: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_POSTS)),
  ),
  since_days: v.optional(v.picklist(sinceDays)),
  media_only: v.optional(v.boolean()),
  include_shared: v.optional(v.boolean()),
  capture_references: v.optional(v.boolean()),
  relations: v.optional(v.boolean()),
})
// eslint-disable-next-line @typescript-eslint/no-redeclare -- schema and type share the name
export type OptionsBody = v.InferOutput<typeof OptionsBody>

/** A request's options with the defaults filled in. */
export function resolveOptions(body: OptionsBody = {}): CaptureOptions {
  const posts = body.posts ?? DEFAULT_OPTIONS.posts
  if (body.count !== undefined && posts !== 'latest' && posts !== 'max')
    throw new AppError('invalid_request', '只有最新和最多可以设置条数')
  return normalize({
    posts,
    count: body.count,
    sinceDays: body.since_days,
    mediaOnly: body.media_only ?? DEFAULT_OPTIONS.mediaOnly,
    includeShared: body.include_shared ?? DEFAULT_OPTIONS.includeShared,
    captureReferences:
      body.capture_references ?? DEFAULT_OPTIONS.captureReferences,
    relations: body.relations ?? DEFAULT_OPTIONS.relations,
  })
}

/** One spelling for each choice, so equal options compare equal. */
function normalize(options: CaptureOptions): CaptureOptions {
  const { count, sinceDays, ...rest } = options
  return {
    ...rest,
    ...(rest.posts === 'latest' ? { count: count ?? DEFAULT_LATEST } : {}),
    ...(rest.posts === 'max' && count !== undefined ? { count } : {}),
    ...(sinceDays === undefined ? {} : { sinceDays }),
  }
}

export function checkOptions(options: CaptureOptions): void {
  if (
    !postModes.includes(options.posts) ||
    (options.count !== undefined &&
      (!Number.isSafeInteger(options.count) ||
        options.count < 1 ||
        options.count > MAX_POSTS)) ||
    (options.sinceDays !== undefined && !sinceDays.includes(options.sinceDays))
  )
    throw new AppError('invalid_target')
}

/** The options a run was asked for, without what it resolved on the way. */
export function publicOptions(stored: StoredOptions): CaptureOptions {
  const { since: _, finalPage: __, ...options } = stored
  return normalize(options)
}

/** A submission's stored options; none stored means the defaults. */
export function storedOptions(value: unknown): StoredOptions {
  return (value as StoredOptions | null) ?? DEFAULT_OPTIONS
}

/** Fix the date cutoff of a run that starts now; its pages keep it. */
export function startOptions(
  options: StoredOptions,
  now: number,
): StoredOptions {
  if (options.sinceDays === undefined || options.since) return options
  return {
    ...options,
    since: new Date(now - options.sinceDays * 86_400_000).toISOString(),
  }
}

export const timelineCap = (ctx: CaptureContext) =>
  ctx.timelineCap ?? TIMELINE_CAP

/**
 * The first page's size and the run's post budget; a budget of 0 is
 * unlimited for `max` and reads nothing more otherwise.
 */
export function budget(
  ctx: CaptureContext,
  options: CaptureOptions,
): { collectionLimit: number; pageSize: number } {
  let limit = 0
  if (options.posts === 'latest' || options.posts === 'max')
    limit = options.count ?? 0
  else if (options.posts === 'until_existing') limit = timelineCap(ctx)
  return { collectionLimit: limit, pageSize: Math.min(limit, 100) }
}

/** The JSON a record shows of the options it ran with. */
export function optionsJson(options: CaptureOptions): OptionsBody {
  return {
    posts: options.posts,
    ...(options.count === undefined ? {} : { count: options.count }),
    ...(options.sinceDays === undefined
      ? {}
      : { since_days: options.sinceDays }),
    media_only: options.mediaOnly,
    include_shared: options.includeShared,
    capture_references: options.captureReferences,
    relations: options.relations,
  }
}

export interface ListedTarget {
  publishedAt: string
  mediaTypes: string[]
  postType: string
}

/** Whether a listed timeline post passes the options' filters. */
export function matchesOptions(
  options: StoredOptions,
  target: ListedTarget,
): boolean {
  if (
    !options.includeShared &&
    (target.postType === 'quote' || target.postType === 'repost')
  )
    return false
  // A pure repost is the original itself.
  if (!options.captureReferences && target.postType === 'repost') return false
  if (options.mediaOnly && target.mediaTypes.length === 0) return false
  if (options.since) {
    const published = Date.parse(target.publishedAt)
    if (Number.isNaN(published) || published < Date.parse(options.since))
      return false
  }
  return true
}
