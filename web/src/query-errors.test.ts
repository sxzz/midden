import { QUERY_ERROR_KINDS } from '@midden/server/query'
import { expect, it } from 'vitest'
import { readQuery } from './query'
import { queryErrorText } from './query-errors'

const CJK = /\p{Script=Han}/u
const DETAIL = {
  key: 'has',
  value: 'gif',
  allowed: 'image, video',
  found: '(',
  max: 16,
  count: 17,
  platforms: 'x',
}

it('says every kind of error in Chinese', () => {
  for (const kind of QUERY_ERROR_KINDS) {
    const text = queryErrorText(kind, DETAIL, 'English')
    expect(text, kind).toMatch(CJK)
    expect(text, kind).not.toMatch(/undefined|English/)
  }
  // What a bad value takes, by its key.
  expect(
    queryErrorText('bad_value', { key: 'has', allowed: 'image, video' }),
  ).toBe('has: 只能是 image、video')
  expect(queryErrorText('bad_value', { key: 'since', value: 'x' })).toBe(
    'since: 要写日期（YYYY-MM-DD）或时刻',
  )
  // A kind it does not know keeps the server's words.
  expect(queryErrorText('new_kind', {}, 'As the server says.')).toBe(
    'As the server says.',
  )
})

it('reads a query in the app’s words, where it cannot', () => {
  for (const [text, message, position] of [
    ['a (b', '这个 ( 没有闭合', 2],
    ['a)', '这个 ) 前面没有 (', 1],
    ['say "hi', '这个 " 没有闭合', 4],
    ['a OR', 'OR 后面缺少条件', 4],
    ['a - b', '- 后面要紧跟条件，中间不留空格', 2],
    ['()', '括号里是空的', 1],
    ['from:', 'from: 后面缺少值', 0],
    ['is:reply', '收藏库不记录哪些帖子是回复，没有 is:reply', 0],
    ['cats has:gif', 'has: 只能是 image、video、media、link', 5],
  ] as const)
    expect(readQuery(text).error, text).toEqual({ message, position })
})
