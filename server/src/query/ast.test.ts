import { describe, expect, test } from 'vitest'
import { LIMITS, parseQuery, QueryError, type QueryNode } from './ast.ts'
import { printQuery } from './print.ts'

/** A query's tree without where its parts were. */
function shape(node: QueryNode | undefined): unknown {
  if (!node) return undefined
  switch (node.type) {
    case 'and':
    case 'or':
      return { [node.type]: node.items.map(shape) }
    case 'not':
      return { not: shape(node.item) }
    case 'atom':
      return `${node.key}:${node.value}`
    default:
      return `${node.type} ${node.value}`
  }
}

const read = (text: string) => shape(parseQuery(text))
const canonical = (text: string) => printQuery(parseQuery(text))

function error(text: string): { message: string; position: number } {
  try {
    parseQuery(text)
  } catch (error_) {
    if (error_ instanceof QueryError)
      return { message: error_.message, position: error_.position }
    throw error_
  }
  throw new Error(`${text} parsed`)
}

describe('reading', () => {
  test('terms, AND by space, OR in capitals, - before a term', () => {
    expect(read('猫 photo')).toEqual({ and: ['word 猫', 'word photo'] })
    expect(read('a b OR c')).toEqual({
      or: [{ and: ['word a', 'word b'] }, 'word c'],
    })
    expect(read('a (b OR c)')).toEqual({
      and: ['word a', { or: ['word b', 'word c'] }],
    })
    expect(read('a or b')).toEqual({ and: ['word a', 'word or', 'word b'] })
    expect(read('ORANGE OR x')).toEqual({ or: ['word ORANGE', 'word x'] })
    expect(read('-#Ad -from:@Bob')).toEqual({
      and: [{ not: 'hashtag ad' }, { not: 'from:@bob' }],
    })
    expect(error('--x')).toMatchObject({ position: 0 })
    expect(read('-(-x)')).toBe('word x')
  })

  test('words keep - and : inside them; links stay words', () => {
    expect(read('x-ray')).toBe('word x-ray')
    expect(read('https://x.com/a#b')).toBe('word https://x.com/a#b')
    expect(read('10:30 Re:ゼロ')).toEqual({
      and: ['word 10:30', 'word Re:ゼロ'],
    })
    expect(read('鏡音レンの絵')).toBe('word 鏡音レンの絵')
  })

  test('phrases, hashtags and values, canonical', () => {
    expect(read('"hello  world"')).toBe('phrase hello  world')
    expect(read('#ＣＡＴＳ ＃猫')).toEqual({
      and: ['hashtag cats', 'hashtag 猫'],
    })
    expect(read('tag:"my tag" folder:猫')).toEqual({
      and: ['tag:my tag', 'folder:猫'],
    })
    expect(read('from:X:@Alice mentions:@Bob reposted-by:@Carol')).toEqual({
      and: ['from:x:@alice', 'mentions:@bob', 'reposted-by:@carol'],
    })
    expect(read('domain:https://www.YouTube.com/watch')).toBe(
      'domain:youtube.com',
    )
    expect(read('rel:following:@a type:account sensitive:true')).toEqual({
      and: ['rel:following:@a', 'type:profile', 'sensitive:yes'],
    })
    expect(read('since:2026-01-31 within:30D saved:7d')).toEqual({
      and: ['since:2026-01-31', 'within:30d', 'saved:7d'],
    })
    // What folders saved as list filters say: moments, in UTC; accounts,
    // a post's relatives, several perspectives and how many must agree.
    expect(
      read('saved-since:2026-11-01T09:00:00+09:00 until:2026-11-02T00:00:00Z'),
    ).toEqual({
      and: [
        'saved-since:2026-11-01T00:00:00.000Z',
        'until:2026-11-02T00:00:00.000Z',
      ],
    })
    expect(
      read(
        'protected:Yes related:0193B6E0-0000-7000-8000-000000000001 from:x/x.profile/42',
      ),
    ).toEqual({
      and: [
        'protected:yes',
        'related:0193b6e0-0000-7000-8000-000000000001',
        'from:x/x.profile/42',
      ],
    })
    expect(read('rel:following:x:@b,@A')).toBe('rel:following:@a,x:@b')
    expect(read('rel:following:2:@b,@a')).toBe('rel:following:@a,@b')
    expect(read('rel:mutual:1:@b,@a,@c')).toBe('rel:mutual:1:@a,@b,@c')
    // A quote in quotes is written twice.
    expect(read('"say ""hi"""')).toBe('phrase say "hi"')
    expect(read('tag:"a ""b"""')).toBe('tag:a "b"')
  })

  test('printed canonically, and read back the same', () => {
    expect(canonical('  a   b OR  c ')).toBe('(a b) OR c')
    expect(canonical('-(a OR b) #X tag:"my tag"')).toBe(
      '-(a OR b) #x tag:"my tag"',
    )
    expect(canonical('a (b (c d))')).toBe('a b c d')
    expect(canonical('')).toBe('')
    for (const text of [
      '(a b) OR c',
      '-(a OR b) #x tag:"my tag"',
      'from:@a (is:quote OR is:repost) -lang:ja since:2026-01-01',
      '"say ""hi""" tag:"a ""b"""',
      'rel:followers:1:@a,@b protected:no',
    ])
      expect(canonical(canonical(text))).toBe(canonical(text))
  })

  test('errors say what and where', () => {
    expect(error('a (b')).toEqual({
      message: 'This ( is never closed.',
      position: 2,
    })
    expect(error('a)')).toMatchObject({ position: 1 })
    expect(error('say "hi')).toMatchObject({ position: 4 })
    expect(error('a OR')).toMatchObject({
      message: 'The query ends too early: OR needs a term after it.',
    })
    expect(error('a - b')).toMatchObject({ position: 2 })
    expect(error('x OR OR y').message).toContain('OR')
    expect(error('()')).toMatchObject({ position: 1 })
    expect(error('from:')).toMatchObject({ position: 0 })
    expect(error('cats since:yesterday')).toEqual({
      message:
        'since: takes a date, YYYY-MM-DD, or a moment (2026-11-01T00:00:00+09:00).',
      position: 5,
    })
    expect(error('since:2026-02-30').message).toContain('YYYY-MM-DD')
    expect(error('is:reply').message).toContain('replies')
    expect(error('has:gif').message).toBe(
      'has: takes image, video, media, link.',
    )
    expect(error('#ａ（ｂ）').position).toBe(0)
    expect(error('rel:following:3:@a,@b').position).toBe(0)
    expect(error('related:p1').position).toBe(0)
    expect(error('protected:maybe').position).toBe(0)
  })

  test('limits: terms, depth, alternatives, value length', () => {
    const many = Array.from({ length: LIMITS.atoms + 1 }, (_, i) => `w${i}`)
    expect(error(many.join(' '))).toEqual({
      message: `At most ${LIMITS.atoms} terms in a query; this one has ${LIMITS.atoms + 1}.`,
      position: many.slice(0, LIMITS.atoms).join(' ').length + 1,
    })
    expect(() =>
      parseQuery(many.slice(0, LIMITS.atoms).join(' ')),
    ).not.toThrow()
    // and, or, and, or: four levels.
    expect(() => parseQuery('a (b OR (c (d OR e)))')).not.toThrow()
    expect(error('a (b OR (c (d OR -e)))').message).toContain('deep')
    const alternatives = Array.from({ length: 9 }, (_, i) => `w${i}`)
    expect(error(alternatives.join(' OR ')).message).toContain('alternatives')
    expect(error(`tag:${'x'.repeat(65)}`).message).toContain('64')
  })
})

/** Deterministic pseudo-random numbers. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

const LEAVES = [
  'cat',
  '猫',
  'x-ray',
  'https://a.test/x#y',
  '"big cat"',
  '#cats',
  '#猫',
  'from:@alice',
  'from:x:@bob',
  'reposted-by:@carol',
  'mentions:@bob',
  'domain:a.test',
  'lang:ja',
  'has:image',
  'is:quote',
  'tag:"my tag"',
  'folder:cats',
  'since:2026-01-01',
  'within:7d',
  'saved:2026-11-01',
  'rel:mutual:@alice',
  'type:post',
  'sensitive:no',
  'state:deleted',
  'platform:x',
]

/** A random query text within the limits. */
function randomQuery(next: () => number, depth = 0): string {
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!
  const roll = next()
  if (depth >= 3 || roll < 0.45) {
    const leaf = pick(LEAVES)
    return next() < 0.25 ? `-${leaf}` : leaf
  }
  const n = 2 + Math.floor(next() * 2)
  const items = Array.from({ length: n }, () => randomQuery(next, depth + 1))
  const joined = roll < 0.75 ? items.join(' ') : items.join(' OR ')
  return depth || next() < 0.5
    ? `${next() < 0.2 ? '-' : ''}(${joined})`
    : joined
}

test('random queries: print, read back, the same query', () => {
  const next = random(7)
  let checked = 0
  for (let i = 0; i < 500; i++) {
    const text = randomQuery(next)
    let node: QueryNode | undefined
    try {
      node = parseQuery(text)
    } catch (error_) {
      // Over a limit; anything else is a bug.
      expect(error_).toBeInstanceOf(QueryError)
      expect((error_ as QueryError).message).toMatch(/at most|deep/i)
      continue
    }
    const printed = printQuery(node)
    expect(shape(parseQuery(printed))).toEqual(shape(node))
    expect(printQuery(parseQuery(printed))).toBe(printed)
    checked++
  }
  expect(checked).toBeGreaterThan(300)
})
