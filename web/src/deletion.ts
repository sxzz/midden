import { storageSize } from './presentation'
import type { client, VideoRemovalEffect } from './api'
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
    ...(counts.profiles ? [`${counts.profiles}个账号`] : []),
    ...(posts ? [`${posts}条帖子`] : []),
  ]
  let text = `将删除${parts.join('、')}`
  const kept = reasons.filter(([key]) => counts.kept[key] > 0)
  if (withPosts && kept.length) {
    const total = kept.reduce((n, [key]) => n + counts.kept[key], 0)
    text += `（保留${total}条：${kept
      .map(([key, label]) => `${label}${counts.kept[key]}条`)
      .join('、')}）`
  }
  return text
}

/**
 * The exact effect of 删除所有视频 of a profile, as its confirmation states
 * it: the videos that go, from how many posts, and the space they free;
 * then the posts that keep theirs, by the reason deleting the profile with
 * its posts would keep them, and the videos another collection also has.
 */
export function videoRemovalSummary(effect: VideoRemovalEffect): string {
  let text = effect.videos
    ? `将删除${effect.posts}条帖子的${effect.videos}个视频`
    : '没有可删除的视频'
  if (effect.videos) {
    const freed = effect.freed_bytes
      ? `，可释放${storageSize(effect.freed_bytes)}`
      : ''
    if (!effect.shared) text += freed || '，这些视频未保存，不占用空间'
    else if (freed)
      text += `${freed}；其中${effect.shared}个视频其他收藏仍在使用，不会释放空间`
    else text += '，其他收藏仍在使用，不会释放空间'
  }
  const notes: string[] = []
  const kept = reasons.filter(([key]) => effect.kept[key] > 0)
  if (kept.length) {
    const total = kept.reduce((n, [key]) => n + effect.kept[key], 0)
    notes.push(
      `保留${total}条帖子的视频：${kept
        .map(([key, label]) => `${label}${effect.kept[key]}条`)
        .join('、')}`,
    )
  }
  if (effect.elsewhere)
    notes.push(`另有${effect.elsewhere}个视频其他收藏也有，保留`)
  if (notes.length) text += `（${notes.join('；')}）`
  return text
}
