import { expect, it } from 'vitest'
import { deletionSummary, type DeleteCounts } from './deletion'

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
