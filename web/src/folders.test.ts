import { expect, it } from 'vitest'
import {
  apiQuery,
  folderAddress,
  folderFilter,
  folderKinds,
  folderModified,
  folderQuery,
  hasFilters,
  listTab,
  localZone,
  retagQuery,
} from './folders'
import { listSort, listsProfiles } from './presentation'

it('saves the API query of what the list shows, in the server’s form', () => {
  expect(
    folderFilter(
      'tag=t1&layout=album&q=&author=x%2Fp%2F2&author=x%2Fp%2F1&sort=saved',
    ),
  ).toBe('author=x%2Fp%2F1&author=x%2Fp%2F2&sort=saved&tag=t1')
  // A folder holds both kinds: the 账号 tab's types are no filter, and a
  // platform keeps both of its kinds.
  expect(folderFilter('entity_type=x.profile,instagram.profile')).toBe('')
  expect(folderFilter('entity_type=instagram.profile&q=a')).toBe(
    'entity_type=instagram.post%2Cinstagram.profile&q=a',
  )
  expect(folderFilter('tag=t1&entity_type=&tab=profile')).toBe('tag=t1')
  expect(folderFilter('entity_type=x.post,x.profile&tab=post')).toBe(
    'entity_type=x.post%2Cx.profile',
  )
  // Local days become the save times the list asks for.
  const filter = new URLSearchParams(
    folderFilter('from_date=2026-03-01&to_date=2026-03-31'),
  )
  expect(filter.get('saved_from')).toBe(
    new Date('2026-03-01T00:00:00').toISOString(),
  )
  expect(filter.get('saved_before')).toBe(
    new Date('2026-04-01T00:00:00').toISOString(),
  )
  expect(filter.has('from_date')).toBe(false)
})

it('keeps a relative save date relative, in the browser’s time zone', () => {
  const filter = folderFilter('saved_within=7d&tab=post')
  expect(Object.fromEntries(new URLSearchParams(filter))).toEqual({
    saved_within: '7d',
    time_zone: localZone(),
  })
  // The browser's own zone goes without saying in the address.
  expect(folderQuery(filter)).toBe('saved_within=7d')
  expect(folderModified('saved_within=7d', filter)).toBe(false)
  expect(folderModified('saved_within=30d', filter)).toBe(true)
  // Another zone, saved elsewhere, stays the folder's.
  const elsewhere = 'saved_within=1d&time_zone=Pacific%2FKiritimati'
  expect(folderQuery(elsewhere)).toBe(elsewhere)
  expect(folderModified(folderQuery(elsewhere), elsewhere)).toBe(false)
  // A zone without a relative date means nothing.
  expect(apiQuery('time_zone=UTC&q=a')).toBe('q=a')
})

it('opens a folder at the address query it was saved from', () => {
  const address = 'from_date=2026-03-01&to_date=2026-03-31&media_type=image'
  const saved = folderFilter(address)
  const query = new URLSearchParams(folderQuery(saved))
  expect(Object.fromEntries(query)).toEqual({
    from_date: '2026-03-01',
    to_date: '2026-03-31',
    media_type: 'image',
  })
  expect(folderModified(query.toString(), saved)).toBe(false)
  // An empty filter still reads as one, not as a bare folder address.
  expect(folderQuery('')).toBe('entity_type=')
  expect(folderAddress('layout=album&tab=post')).toBe(
    'layout=album&tab=post&entity_type=',
  )
  expect(folderAddress('q=a')).toBe('q=a')
})

it('tells a changed filter from a changed layout or tab', () => {
  const filter = folderFilter('media_type=video')
  const shown = folderQuery(filter)
  expect(folderModified(`${shown}&layout=album`, filter)).toBe(false)
  expect(folderModified(`${shown}&tab=profile`, filter)).toBe(false)
  expect(folderModified(`${shown}&tab=post`, filter)).toBe(false)
  expect(folderModified(`${shown}&order=asc`, filter)).toBe(true)
  // One platform is a filter.
  expect(folderModified(`${shown}&entity_type=x.post`, filter)).toBe(true)
  const x = folderFilter('media_type=video&entity_type=x.post')
  expect(folderModified(`${folderQuery(x)}&tab=profile`, x)).toBe(false)
})

it('splits a folder into the kinds its results hold', () => {
  // The counts decide, and unknown counts keep both.
  expect(folderKinds()).toEqual(['post', 'profile'])
  expect(folderKinds({ 'x.post': 2, 'instagram.profile': 1 })).toEqual([
    'post',
    'profile',
  ])
  expect(folderKinds({ 'instagram.profile': 1 })).toEqual(['profile'])
  expect(folderKinds({})).toEqual(['post'])
  // Each tab asks for its own kind, within the filter's types.
  expect(apiQuery('q=a&tab=profile', 'profile')).toBe(
    'q=a&entity_type=x.profile%2Cinstagram.profile',
  )
  expect(apiQuery('entity_type=x.post,x.profile', 'post')).toBe(
    'entity_type=x.post',
  )
  // The tab decides the list's kind and its default order.
  expect(listsProfiles('entity_type=x.post,x.profile&tab=profile')).toBe(true)
  expect(listSort('tab=post')).toBe('published')
  expect(listSort('tab=profile')).toBe('saved')
})

it('knows which tab and which filters a query has', () => {
  expect(listTab('entity_type=instagram.profile')).toBe('x.profile')
  expect(listTab('q=a')).toBe('x.post')
  expect(apiQuery('layout=album', 'post')).toBe(
    'entity_type=x.post%2Cinstagram.post',
  )
  expect(apiQuery('layout=album')).toBe('')
  expect(hasFilters('')).toBe(false)
  expect(hasFilters('layout=album&entity_type=x.post,instagram.post')).toBe(
    false,
  )
  expect(hasFilters('q=')).toBe(false)
  // One platform is a filter; both of them are just the tab.
  expect(hasFilters('entity_type=x.post')).toBe(true)
  expect(hasFilters('sort=saved')).toBe(true)
  expect(hasFilters('saved_within=7d')).toBe(true)
})

it('writes tag lists as sets, the way the server stores them', () => {
  expect(folderFilter('tag=b,a,b&tag_mode=all&not_tag=c')).toBe(
    'not_tag=c&tag=a%2Cb&tag_mode=all',
  )
  // One tag matches the same either way.
  expect(folderFilter('tag=a&tag_mode=all')).toBe('tag=a')
  expect(folderModified('tag=b,a', 'tag=a%2Cb')).toBe(false)
})

it('moves folder filters along with a merged or deleted tag', () => {
  expect(retagQuery('q=x', 'a', 'b')).toBe('q=x')
  expect(retagQuery('tag=a%2Cb&tag_mode=all', 'a', 'b')).toBe('tag=b')
  expect(retagQuery('not_tag=d&tag=a%2Cc', 'a', 'b')).toBe(
    'not_tag=d&tag=b%2Cc',
  )
  // Wanted and excluded at once after a merge: wanting it wins.
  expect(retagQuery('tag=b&not_tag=a', 'a', 'b')).toBe('tag=b')
  expect(retagQuery('not_tag=a&q=x', 'a')).toBe('q=x')
  expect(retagQuery('tag=a%2Cc&tag_mode=all', 'a')).toBe('tag=c')
})

it('saves perspectives as a set, the default threshold left out', () => {
  const a = encodeURIComponent('x/x.profile/1')
  const b = encodeURIComponent('x/x.profile/2')
  expect(
    folderFilter(`rel_of=${b}&rel=following&rel_of=${a}&rel_of=${b}&rel_min=2`),
  ).toBe(`rel=following&rel_of=${a}&rel_of=${b}`)
  expect(folderFilter(`rel_of=${b}&rel_of=${a}&rel=following&rel_min=1`)).toBe(
    `rel=following&rel_min=1&rel_of=${a}&rel_of=${b}`,
  )
  expect(folderFilter(`rel_of=${a}&rel=mutual&rel_min=1`)).toBe(
    `rel=mutual&rel_of=${a}`,
  )
})
