import { expect, it } from 'vitest'
import {
  completing,
  composeQuery,
  hasDates,
  hasTerms,
  KEYS,
  readQuery,
  searchesWords,
  splitQuery,
  wordsOf,
  type Controls,
} from './query'

const NONE: Controls = {
  platform: '',
  tag: [],
  tagMode: '',
  notTag: [],
  relOf: [],
  rel: '',
  relMin: 0,
  postType: '',
  authors: [],
  media: [],
  visibility: '',
  sensitive: '',
  sourceState: '',
  from: '',
  to: '',
  within: '',
}
const TAGS = [
  { id: '0193b6e0-0000-7000-8000-00000000000a', name: '猫' },
  { id: '0193b6e0-0000-7000-8000-00000000000b', name: 'to read' },
]
const tagName = (id: string) => TAGS.find((t) => t.id === id)?.name
const tagId = (ref: string) =>
  TAGS.find((t) => t.id === ref || t.name === ref)?.id
const split = (text: string) => splitQuery(readQuery(text).node, tagId)

it('reads a query as the server does, with where it cannot', () => {
  expect(readQuery('a  OR b c').parsed).toBe('a OR (b c)')
  expect(readQuery('cats since:yesterday').error).toEqual({
    message: 'since: 要写日期（YYYY-MM-DD）或时刻',
    position: 5,
  })
  expect(readQuery('a (b').error?.position).toBe(2)
})

it('shows the controls as terms after the search’s own', () => {
  const controls: Controls = {
    ...NONE,
    platform: 'x',
    tag: TAGS.map((t) => t.id),
    authors: ['x/x.profile/2', 'x/x.profile/1'],
    media: ['image', 'text'],
    postType: 'quote',
    notTag: [],
    visibility: 'private',
    within: '7d',
  }
  expect(composeQuery('cat OR dog', controls, { tagName })).toBe(
    '(cat OR dog) platform:x (from:x/x.profile/1 OR from:x/x.profile/2) (has:image OR -has:media) is:quote (tag:猫 OR tag:"to read") protected:yes saved:7d',
  )
  expect(
    composeQuery(
      '',
      {
        ...NONE,
        tag: [TAGS[0]!.id],
        notTag: [TAGS[1]!.id],
        from: '2026-11-01',
        to: '2026-11-05',
      },
      { tagName },
    ),
  ).toBe('tag:猫 -tag:"to read" saved-since:2026-11-01 saved-until:2026-11-06')
})

it('gives each control the terms it says, and keeps the rest', () => {
  const all = split(
    'cat #art platform:x has:video is:original tag:猫 tag:"to read" -tag:x sensitive:no state:deleted saved-since:2026-11-01 saved-until:2026-11-06 from:x/x.profile/1',
  )
  expect(all.controls).toEqual({
    platform: 'x',
    media: ['video'],
    postType: 'post',
    tag: TAGS.map((t) => t.id),
    tagMode: 'all',
    sensitive: 'not_contains',
    sourceState: 'deleted',
    from: '2026-11-01',
    to: '2026-11-05',
    authors: ['x/x.profile/1'],
  })
  // An unknown tag stays a term: the server says it is unknown.
  expect(all.q).toBe('cat #art -tag:x')
  // Alternatives across fields, handles, and what no control has.
  for (const text of [
    'has:image OR from:x/x.profile/1',
    'from:@alice',
    'domain:a.test lang:ja',
    'rel:following:@alice',
  ])
    expect(split(text)).toEqual({ controls: {}, q: readQuery(text).parsed })
  expect(
    split('(tag:猫 OR tag:"to read") rel:mutual:1:x/x.profile/2,x/x.profile/1')
      .controls,
  ).toEqual({
    tag: TAGS.map((t) => t.id),
    tagMode: '',
    rel: 'mutual',
    relOf: ['x/x.profile/1', 'x/x.profile/2'],
    relMin: 1,
  })
  // Wanted and excluded at once: the exclusion stays a term.
  expect(split('tag:猫 -tag:猫')).toEqual({
    controls: { tag: [TAGS[0]!.id], tagMode: '', notTag: [] },
    q: `-tag:${TAGS[0]!.id}`,
  })
})

it('reads back what it showed', () => {
  const controls: Controls = {
    ...NONE,
    media: ['image', 'video'],
    tag: [TAGS[1]!.id],
    notTag: [TAGS[0]!.id],
    relOf: ['x/x.profile/1'],
    rel: 'following',
    within: '30d',
    sensitive: 'contains',
  }
  const shown = composeQuery('"two words" -spam', controls, { tagName })
  const back = split(shown)
  expect(back.q).toBe('"two words" -spam')
  expect({ ...NONE, ...back.controls }).toEqual(controls)
})

it('knows words, dates and terms apart', () => {
  expect(searchesWords('cat has:image')).toBe(true)
  expect(searchesWords('has:image -cat')).toBe(false)
  expect(searchesWords('#art')).toBe(false)
  expect(hasDates('cat since:2026-01-01')).toBe(true)
  expect(hasDates('cat saved:7d')).toBe(true)
  expect(hasDates('cat 2026-01-01')).toBe(false)
  expect(hasTerms('cat dog')).toBe(false)
  expect(hasTerms('cat #art')).toBe(true)
  expect(wordsOf('cat -dog "two words" OR from:@a')).toEqual([
    'cat',
    'two words',
  ])
})

it('completes keys, values and what the library holds', () => {
  const at = (text: string, caret = text.length) =>
    completing(text, caret, KEYS)
  expect(at('cat fr')).toMatchObject({
    start: 4,
    prefix: 'fr',
    source: { kind: 'keys' },
  })
  expect(at('from:@al')).toMatchObject({
    lead: 'from:',
    prefix: '@al',
    source: { kind: 'remote', remote: 'handle' },
  })
  expect(at('-mentions:x:@b')).toMatchObject({
    lead: '-mentions:x:',
    prefix: '@b',
  })
  expect(at('(#ca')).toMatchObject({
    start: 1,
    lead: '#',
    prefix: 'ca',
    source: { remote: 'hashtag' },
  })
  expect(at('has:im')).toMatchObject({
    lead: 'has:',
    prefix: 'im',
    source: { kind: 'values', values: ['image', 'video', 'media', 'link'] },
  })
  expect(at('rel:fo')).toMatchObject({ source: { kind: 'values' } })
  expect(at('rel:following:@a,@b')).toMatchObject({
    lead: 'rel:following:@a,',
    prefix: '@b',
    source: { remote: 'handle' },
  })
  expect(at('tag:"to r')).toMatchObject({
    lead: 'tag:"',
    prefix: 'to r',
    source: { remote: 'tag' },
  })
  // Inside a phrase, and a plain word: nothing.
  expect(at('"from:x')).toBeUndefined()
  expect(at('cat')).toBeUndefined()
  // The term the caret is in, up to its end.
  expect(at('from:@al cat', 7)).toMatchObject({ start: 0, end: 8 })
})

it('names authors by the handle that names them alone, and reads it back', () => {
  const terms: Record<string, string> = { 'x/x.profile/1': '@alice' }
  const names = {
    tagName,
    authorTerm: (key: string) => terms[key],
  }
  const controls = {
    ...NONE,
    authors: ['x/x.profile/2', 'x/x.profile/1'],
  }
  // A key with no handle that names it alone stays a key.
  const shown = composeQuery('', controls, names)
  expect(shown).toBe('(from:@alice OR from:x/x.profile/2)')
  const back = splitQuery(readQuery(shown).node, tagId, (term) =>
    Object.keys(terms).find((key) => terms[key] === term),
  )
  expect(back).toEqual({
    controls: { authors: ['x/x.profile/1', 'x/x.profile/2'] },
    q: '',
  })
  // A handle the box did not write is the query's.
  expect(split('from:@bob')).toEqual({ controls: {}, q: 'from:@bob' })
})
