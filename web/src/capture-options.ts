import type { CaptureOptions } from './api'

export type PostMode = NonNullable<CaptureOptions['posts']>
export type SinceDays = NonNullable<CaptureOptions['since_days']>

/** Every choice spelled out: what the forms edit and the server fills in. */
export type Options = Required<Omit<CaptureOptions, 'count' | 'since_days'>> &
  Pick<CaptureOptions, 'count' | 'since_days'>

export const DEFAULT_COUNT = 100

/** The same everywhere a capture starts; the server's defaults too. */
export const defaultOptions = (): Options => ({
  posts: 'latest',
  count: DEFAULT_COUNT,
  media_only: false,
  include_shared: true,
  capture_references: true,
  relations: false,
})

/**
 * The 帖子范围 choices. 全部 is `max` without a number, so the menu has one
 * entry per meaning, not per API mode.
 */
export type Scope = 'latest' | 'until_existing' | 'max' | 'all'
export const scopes: { value: Scope; label: string }[] = [
  { value: 'latest', label: '最新' },
  { value: 'until_existing', label: '抓到已有数据为止' },
  { value: 'max', label: '最多' },
  { value: 'all', label: '全部' },
]

/**
 * Saved options over the defaults. The default number is only the latest
 * scope's, so it must not turn a saved 全部 into 最多 100.
 */
export function restoreOptions(saved: CaptureOptions): Options {
  const { count: _, ...base } = defaultOptions()
  return { ...base, ...saved }
}

/**
 * What a form sends: a number only where the scope uses one, since the
 * field is hidden otherwise and the server refuses it.
 */
export function optionsBody(o: Options): CaptureOptions {
  const { count, ...rest } = o
  return o.posts === 'latest' || o.posts === 'max'
    ? { ...rest, ...(count === undefined ? {} : { count }) }
    : rest
}

export function scopeOf(o: Pick<Options, 'posts' | 'count'>): Scope {
  if (o.posts === 'max' && o.count === undefined) return 'all'
  return o.posts === 'none' ? 'latest' : o.posts
}

/** Options with the scope chosen; a number carries over where one is used. */
export function withScope(o: Options, scope: Scope): Options {
  const { count: _, ...rest } = o
  if (scope === 'all') return { ...rest, posts: 'max' }
  if (scope === 'until_existing') return { ...rest, posts: scope }
  return { ...rest, posts: scope, count: o.count ?? DEFAULT_COUNT }
}

export const ranges: { value: SinceDays; label: string }[] = [
  { value: 1, label: '最近 1 天' },
  { value: 7, label: '最近 7 天' },
  { value: 30, label: '最近 30 天' },
  { value: 90, label: '最近 90 天' },
  { value: 365, label: '最近一年' },
]

/** What the options apply to: profiles' timelines, single posts or both. */
export interface OptionScope {
  profiles: boolean
  posts: boolean
}

function postsText(o: CaptureOptions) {
  switch (o.posts ?? 'latest') {
    case 'none':
      return '不抓帖子'
    case 'until_existing':
      return '抓到已有数据为止'
    case 'max':
      return o.count === undefined ? '全部帖子' : `最多 ${o.count} 条`
    default:
      return `最新 ${o.count ?? DEFAULT_COUNT} 条`
  }
}

/**
 * The options in a line, e.g. 仅媒体 · 最近 7 天 · 抓关系网: what differs
 * from the defaults among what applies to the target, or the post scope
 * when nothing does. A post with the defaults says nothing.
 */
export function optionsSummary(o: CaptureOptions, applies: OptionScope) {
  const parts: string[] = []
  const timeline = applies.profiles && o.posts !== 'none'
  if (applies.profiles) {
    const posts = postsText(o)
    if (posts !== postsText(defaultOptions())) parts.push(posts)
  }
  if (timeline) {
    if (o.media_only) parts.push('仅媒体')
    if (o.include_shared === false) parts.push('不含转帖')
  }
  if ((timeline || applies.posts) && o.capture_references === false)
    parts.push('不抓原帖')
  if (timeline && o.since_days)
    parts.push(ranges.find((r) => r.value === o.since_days)?.label ?? '')
  if (applies.profiles && o.relations) parts.push('抓关系网')
  if (!parts.length && applies.profiles) parts.push(postsText(o))
  return parts.join(' · ')
}
