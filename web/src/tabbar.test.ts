import { describe, expect, it } from 'vitest'
import { defaultCenter } from './graph-center'
import { buildFacts } from './settings'
import {
  barHidden,
  isTabRoot,
  nextScroll,
  scrollStart,
  suppressTabBar,
  tabBarSuppressed,
  tabOf,
  type ScrollState,
} from './tabbar'

describe('which tab a page belongs to', () => {
  it('lights a tab on its root and every page below it', () => {
    for (const name of [
      'collections',
      'folder',
      'collection',
      'collection-stats',
      'collection-changes',
      'collection-follows',
      'captures',
      'capture',
    ])
      expect(tabOf(name)).toBe('explore')
    for (const name of ['relations', 'collection-graph', 'compare'])
      expect(tabOf(name)).toBe('relations')
    for (const name of [
      'settings',
      'settings-accounts',
      'settings-passkeys',
      'settings-admin',
      'settings-storage',
    ])
      expect(tabOf(name)).toBe('settings')
    // Public and setup pages are no tab's.
    for (const name of ['share', 'share-collection', 'passkey', undefined])
      expect(tabOf(name)).toBeUndefined()
  })

  it('knows the roots from the pages below them', () => {
    expect(['collections', 'relations', 'settings'].every(isTabRoot)).toBe(true)
    expect(
      ['collection', 'folder', 'collection-graph', 'settings-admin'].some(
        isTabRoot,
      ),
    ).toBe(false)
  })
})

describe('auto-hide', () => {
  /** Scroll through `ys` on a page that scrolls up to `max`. */
  const through = (ys: number[], max = 5000, from = scrollStart()) =>
    ys.reduce<ScrollState[]>(
      (states, y) => [...states, nextScroll(states.at(-1) ?? from, y, max)],
      [],
    )
  const hidden = (states: ScrollState[]) => states.map((s) => s.hidden)

  it('hides once the page has moved down past the threshold', () => {
    expect(hidden(through([4, 8, 11, 13, 200]))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ])
  })

  it('shows again once it has moved up as far, not on a jitter', () => {
    const down = through([100, 300]).at(-1)!
    expect(down.hidden).toBe(true)
    // A few pixels back and forth while reading keep it hidden.
    expect(hidden(through([296, 300, 295, 299], 5000, down))).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(hidden(through([290, 280], 5000, down))).toEqual([true, false])
  })

  it('starts counting again when the direction turns', () => {
    const start = { y: 500, hidden: false, travel: 0 }
    // 8 down, 4 up (reset), 8 down: never 12 in one direction.
    expect(hidden(through([508, 504, 512], 5000, start))).toEqual([
      false,
      false,
      false,
    ])
  })

  it('always shows at the top and where the page cannot scroll further', () => {
    const down = through([100, 400]).at(-1)!
    expect(nextScroll(down, 0, 5000).hidden).toBe(false)
    // A rubber-band bounce past either end.
    expect(nextScroll(down, -30, 5000).hidden).toBe(false)
    expect(nextScroll(down, 5000, 5000).hidden).toBe(false)
    expect(nextScroll(down, 5040, 5000).hidden).toBe(false)
    // A page shorter than the window never hides it.
    expect(nextScroll(scrollStart(), 0, 0).hidden).toBe(false)
  })
})

it('hides while any page holds it down', () => {
  suppressTabBar('a', true)
  suppressTabBar('b', true)
  suppressTabBar('a', false)
  expect([...tabBarSuppressed.value]).toEqual(['b'])
  suppressTabBar('b', false)
  expect(tabBarSuppressed.value.size).toBe(0)
})

it('opens 关系 on the owner’s account, else the last one, else the first', () => {
  const accounts = [{ id: 'x/x.profile/1' }, { id: 'x/x.profile/2', own: true }]
  expect(defaultCenter(accounts, 'x/x.profile/9')).toBe('x/x.profile/2')
  expect(defaultCenter([accounts[0]!], 'x/x.profile/9')).toBe('x/x.profile/9')
  expect(defaultCenter([accounts[0]!])).toBe('x/x.profile/1')
  // No relation data at all: nothing, not even the last one.
  expect(defaultCenter([], 'x/x.profile/9')).toBe('')
})

it('states the build: its commit linked, and when it was built', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01'
  expect(buildFacts(sha, '')).toEqual({
    version: 'abcdef0',
    commitURL: `https://github.com/sxzz/midden/commit/${sha}`,
    builtAt: '',
  })
  expect(buildFacts(`${sha}-dirty`, '').version).toBe('abcdef0-dirty')
  expect(buildFacts('dev', '2026-11-25T08:00:00Z')).toMatchObject({
    version: 'dev',
    commitURL: '',
    builtAt: expect.stringContaining('2026'),
  })
})

describe('desktop', () => {
  const state = { scrolled: false, typing: false, suppressed: false }
  it('never hides the bar on scrolling there, only for the 多选 bar', () => {
    expect(barHidden({ ...state, scrolled: true, desktop: true })).toBe(false)
    expect(barHidden({ ...state, typing: true, desktop: true })).toBe(false)
    expect(barHidden({ ...state, suppressed: true, desktop: true })).toBe(true)
    expect(barHidden({ ...state, scrolled: true, desktop: false })).toBe(true)
    expect(barHidden({ ...state, typing: true, desktop: false })).toBe(true)
    expect(barHidden({ ...state, desktop: false })).toBe(false)
  })
})
