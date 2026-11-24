import { expect, it } from 'vitest'
import {
  apiQuery,
  filterKinds,
  folderAddress,
  folderFilter,
  folderKinds,
  folderModified,
  folderQuery,
  hasFilters,
  listTab,
  localZone,
  withTab,
} from './folders'
import { listSort, listsProfiles } from './presentation'

it('saves the API query of what the list shows, in the server’s form', () => {
  // A home tab gives its kind; the address leaves it out.
  expect(
    folderFilter(
      'tag=t1&layout=album&q=&author=x%2Fp%2F2&author=x%2Fp%2F1&sort=saved',
      'post',
    ),
  ).toBe(
    'author=x%2Fp%2F1&author=x%2Fp%2F2&entity_type=x.post%2Cinstagram.post&sort=saved&tag=t1',
  )
  expect(folderFilter('entity_type=x.profile,instagram.profile')).toBe(
    'entity_type=x.profile%2Cinstagram.profile',
  )
  // A folder's address names its types itself, or none: every kind.
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
  const saved = folderFilter(address, 'post')
  const query = new URLSearchParams(folderQuery(saved))
  expect(Object.fromEntries(query)).toEqual({
    entity_type: 'x.post,instagram.post',
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
  const filter = folderFilter('media_type=video', 'post')
  const shown = folderQuery(filter)
  expect(folderModified(`${shown}&layout=album`, filter)).toBe(false)
  expect(folderModified(`${shown}&tab=profile`, filter)).toBe(false)
  expect(folderModified(`${shown}&order=asc`, filter)).toBe(true)
  expect(folderModified('entity_type=x.post', filter)).toBe(true)
})

it('splits a folder into the kinds its results hold', () => {
  expect(filterKinds('')).toEqual(['post', 'profile'])
  expect(filterKinds('entity_type=x.profile')).toEqual(['profile'])
  expect(filterKinds('entity_type=x.post,instagram.profile')).toEqual([
    'post',
    'profile',
  ])
  // One kind named needs no counts.
  expect(folderKinds('entity_type=x.post', {})).toEqual(['post'])
  // Both named or none: the counts decide, and unknown counts keep both.
  expect(folderKinds('q=a')).toEqual(['post', 'profile'])
  expect(folderKinds('q=a', { 'x.post': 2, 'instagram.profile': 1 })).toEqual([
    'post',
    'profile',
  ])
  expect(folderKinds('q=a', { 'instagram.profile': 1 })).toEqual(['profile'])
  expect(folderKinds('q=a', {})).toEqual(['post'])
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
  expect(withTab('q=a', 'x.profile')).toBe(
    'q=a&entity_type=x.profile%2Cinstagram.profile',
  )
  expect(withTab('entity_type=x.post')).toBe('entity_type=x.post')
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
