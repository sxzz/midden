import { expect, it } from 'vitest'
import {
  deletionSummary,
  videoRemovalSummary,
  type DeleteCounts,
} from './deletion'
import type { VideoRemovalEffect } from './api'

const counts = (fields: Partial<DeleteCounts>): DeleteCounts => ({
  profiles: 0,
  posts: 0,
  related: 0,
  kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
  ...fields,
})

it('states what goes, and with the posts what stays and why', () => {
  const both = counts({
    profiles: 3,
    posts: 2,
    related: 410,
    kept: { listed: 12, saved: 20, annotated: 5, quoted: 0 },
  })
  expect(deletionSummary(both, false)).toBe('将删除 3 个账号、2 条帖子')
  expect(deletionSummary(both, true)).toBe(
    '将删除 3 个账号、412 条帖子（保留 37 条：其他账号也关联 12 条、单独收藏 20 条、已整理 5 条）',
  )
  expect(deletionSummary(counts({ posts: 1 }), false)).toBe('将删除 1 条帖子')
  expect(
    deletionSummary(
      counts({ profiles: 1, kept: { ...both.kept, listed: 0, quoted: 2 } }),
      true,
    ),
  ).toBe(
    '将删除 1 个账号（保留 27 条：单独收藏 20 条、已整理 5 条、被其他帖子引用 2 条）',
  )
})

it('states which videos of a profile go, the space freed, and what stays', () => {
  const MB = 1024 * 1024
  const effect = (fields: Partial<VideoRemovalEffect>): VideoRemovalEffect => ({
    posts: 0,
    videos: 0,
    freed_bytes: 0,
    shared: 0,
    kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
    elsewhere: 0,
    ...fields,
  })
  expect(
    videoRemovalSummary(
      effect({
        posts: 412,
        videos: 530,
        freed_bytes: 1200 * MB,
        kept: { listed: 12, saved: 20, annotated: 5, quoted: 0 },
        elsewhere: 3,
      }),
    ),
  ).toBe(
    '将删除 412 条帖子的 530 个视频，可释放 1.2 GB（保留 37 条帖子的视频：其他账号也关联 12 条、单独收藏 20 条、已整理 5 条；另有 3 个视频其他收藏也有，保留）',
  )
  expect(
    videoRemovalSummary(
      effect({ posts: 2, videos: 2, freed_bytes: 2 * MB, shared: 1 }),
    ),
  ).toBe(
    '将删除 2 条帖子的 2 个视频，可释放 2.0 MB；其中 1 个视频其他收藏仍在使用，不会释放空间',
  )
  expect(videoRemovalSummary(effect({ posts: 1, videos: 1, shared: 1 }))).toBe(
    '将删除 1 条帖子的 1 个视频，其他收藏仍在使用，不会释放空间',
  )
  expect(videoRemovalSummary(effect({ posts: 1, videos: 1 }))).toBe(
    '将删除 1 条帖子的 1 个视频，这些视频未保存，不占用空间',
  )
  expect(
    videoRemovalSummary(
      effect({ kept: { listed: 0, saved: 0, annotated: 0, quoted: 2 } }),
    ),
  ).toBe('没有可删除的视频（保留 2 条帖子的视频：被其他帖子引用 2 条）')
  expect(videoRemovalSummary(effect({}))).toBe('没有可删除的视频')
})
