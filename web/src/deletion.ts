import type { client } from './api'
import type { InferResponseType } from 'hono/client'

/** What deleting a selection removes and keeps, from a dry run. */
export type DeleteCounts = InferResponseType<
  typeof client.collections.delete.$post,
  200
>

const reasons = [
  ['listed', '其他账号也关联'],
  ['saved', '单独收藏'],
  ['annotated', '已整理'],
  ['quoted', '被其他帖子引用'],
] as const

/**
 * The exact effect of a deletion, as the confirmation states it: what goes,
 * and with the accounts' posts, how many of those stay and why.
 */
export function deletionSummary(
  counts: DeleteCounts,
  withPosts: boolean,
): string {
  const posts = counts.posts + (withPosts ? counts.related : 0)
  const parts = [
    ...(counts.profiles ? [`${counts.profiles} 个账号`] : []),
    ...(posts ? [`${posts} 条帖子`] : []),
  ]
  let text = `将删除 ${parts.join('、')}`
  const kept = reasons.filter(([key]) => counts.kept[key] > 0)
  if (withPosts && kept.length) {
    const total = kept.reduce((n, [key]) => n + counts.kept[key], 0)
    text += `（保留 ${total} 条：${kept
      .map(([key, label]) => `${label} ${counts.kept[key]} 条`)
      .join('、')}）`
  }
  return text
}
