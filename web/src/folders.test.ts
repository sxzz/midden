import { expect, it } from 'vitest'
import {
  apiQuery,
  folderFilter,
  folderModified,
  folderQuery,
  hasFilters,
  listTab,
  withTab,
} from './folders'

it('saves the API query of what the list shows, in the server’s form', () => {
  expect(
    folderFilter(
      'tag=t1&layout=album&q=&author=x%2Fp%2F2&author=x%2Fp%2F1&sort=saved',
    ),
  ).toBe(
    'author=x%2Fp%2F1&author=x%2Fp%2F2&entity_type=x.post%2Cinstagram.post&sort=saved&tag=t1',
  )
  expect(folderFilter('entity_type=x.profile,instagram.profile')).toBe(
    'entity_type=x.profile%2Cinstagram.profile',
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

it('opens a folder at the address query it was saved from', () => {
  const address = 'from_date=2026-03-01&to_date=2026-03-31&media_type=image'
  const query = new URLSearchParams(folderQuery(folderFilter(address)))
  expect(Object.fromEntries(query)).toEqual({
    entity_type: 'x.post,instagram.post',
    from_date: '2026-03-01',
    to_date: '2026-03-31',
    media_type: 'image',
  })
  expect(folderModified(query.toString(), folderFilter(address))).toBe(false)
})

it('tells a changed filter from a changed layout', () => {
  const filter = folderFilter('media_type=video')
  const shown = folderQuery(filter)
  expect(folderModified(`${shown}&layout=album`, filter)).toBe(false)
  expect(folderModified(`${shown}&order=asc`, filter)).toBe(true)
  expect(folderModified('entity_type=x.post', filter)).toBe(true)
})

it('knows which tab and which filters a query has', () => {
  expect(listTab('entity_type=instagram.profile')).toBe('x.profile')
  expect(listTab('q=a')).toBe('x.post')
  expect(withTab('q=a', 'x.profile')).toBe(
    'q=a&entity_type=x.profile%2Cinstagram.profile',
  )
  expect(withTab('entity_type=x.post')).toBe('entity_type=x.post')
  expect(apiQuery('layout=album')).toBe('entity_type=x.post%2Cinstagram.post')
  expect(hasFilters('')).toBe(false)
  expect(hasFilters('layout=album&entity_type=x.post,instagram.post')).toBe(
    false,
  )
  expect(hasFilters('q=')).toBe(false)
  // One platform is a filter; both of them are just the tab.
  expect(hasFilters('entity_type=x.post')).toBe(true)
  expect(hasFilters('sort=saved')).toBe(true)
})
