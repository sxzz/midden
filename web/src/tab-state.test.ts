import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { createRouter, createWebHashHistory, type Router } from 'vue-router'
import { backRoute, goBack } from './navigation'
import {
  backTarget,
  emptyStates,
  forget,
  lastPage,
  leave,
  leftScroll,
  readStates,
  SWITCH_STATE,
  tabStates,
  trackTabs,
  visit,
  type TabStates,
  type Visit,
} from './tab-state'
import { tabOf } from './tabbar'

/** Show `path` (named `name`), reached by `move` from `from`. */
function go(
  states: TabStates,
  name: string,
  path: string,
  move: Visit['move'] = 'push',
  from?: [string, string],
) {
  return visit(states, {
    tab: tabOf(name)!,
    path,
    root: ['collections', 'captures', 'relations', 'settings'].includes(name),
    move,
    from: from && { tab: tabOf(from[0]), path: from[1] },
  })
}

describe('recording each tab', () => {
  it('starts every tab at its root', () => {
    const states = emptyStates()
    expect(lastPage(states, 'explore')).toBe('/')
    expect(lastPage(states, 'relations')).toBe('/relations')
    expect(lastPage(states, 'settings')).toBe('/settings')
    expect(backTarget(states, 'settings')).toBe('/settings')
  })

  it('keeps the pages opened within a tab, each going back to the one before', () => {
    let states = go(emptyStates(), 'collections', '/?tag=a', 'replace')
    states = go(states, 'collection', '/collection/a', 'push', [
      'collections',
      '/?tag=a',
    ])
    states = go(states, 'collection', '/collection/b', 'push', [
      'collection',
      '/collection/a',
    ])
    expect(states.explore.stack).toEqual([
      '/?tag=a',
      '/collection/a',
      '/collection/b',
    ])
    expect(backTarget(states, 'explore')).toBe('/collection/a')
    // Back through history cuts the chain there.
    states = go(states, 'collection', '/collection/a', 'back', [
      'collection',
      '/collection/b',
    ])
    expect(backTarget(states, 'explore')).toBe('/?tag=a')
    // An address replaced in place takes the last one's place.
    states = go(states, 'folder', '/folder/f?tab=post', 'push', [
      'collection',
      '/collection/a',
    ])
    states = go(states, 'folder', '/folder/f?tab=profile', 'replace', [
      'folder',
      '/folder/f?tab=post',
    ])
    expect(states.explore.stack).toEqual([
      '/?tag=a',
      '/collection/a',
      '/folder/f?tab=profile',
    ])
    // The other tabs are untouched.
    expect(states.settings).toEqual(emptyStates().settings)
  })

  it('pops to the root, remembering it as shown', () => {
    let states = go(emptyStates(), 'collection', '/collection/a', 'push', [
      'collections',
      '/',
    ])
    states = go(states, 'collections', '/?entity_type=x.profile', 'push', [
      'collection',
      '/collection/a',
    ])
    expect(states.explore).toEqual({
      root: '/?entity_type=x.profile',
      stack: ['/?entity_type=x.profile'],
      scroll: 0,
    })
  })

  it('leaves a tab as it was while another is shown, and returns to it', () => {
    let states = go(emptyStates(), 'collection', '/collection/a', 'push', [
      'collections',
      '/',
    ])
    states = leave(states, 'explore', '/collection/a', 640)
    states = go(states, 'captures', '/captures', 'switch', [
      'collection',
      '/collection/a',
    ])
    states = go(states, 'capture', '/captures/1', 'push', [
      'captures',
      '/captures',
    ])
    const before = states.explore
    states = go(states, 'collection', '/collection/a', 'switch', [
      'capture',
      '/captures/1',
    ])
    expect(states.explore).toBe(before)
    expect(leftScroll(states, 'explore', '/collection/a')).toBe(640)
    expect(backTarget(states, 'explore')).toBe('/')
    expect(lastPage(states, 'captures')).toBe('/captures/1')
    // Leaving another page than the last does not move its scroll.
    expect(leave(states, 'explore', '/collection/b', 10)).toBe(states)
    expect(leftScroll(states, 'explore', '/collection/b')).toBeUndefined()
  })

  it('goes back to the page of another tab that opened one', () => {
    const states = go(emptyStates(), 'collection', '/collection/a', 'push', [
      'collection-graph',
      '/collection/p/graph',
    ])
    expect(backTarget(states, 'explore')).toBe('/collection/p/graph')
  })

  it('goes back to the root from a page opened directly', () => {
    const states = go(emptyStates(), 'capture', '/captures/1', 'load')
    expect(states.captures.stack).toEqual(['/captures/1'])
    expect(backTarget(states, 'captures')).toBe('/captures')
  })

  it('forgets the pages of deleted collections', () => {
    let states = go(emptyStates(), 'collection', '/collection/a', 'push', [
      'collections',
      '/',
    ])
    states = go(states, 'collection-stats', '/collection/a/stats', 'push', [
      'collection',
      '/collection/a',
    ])
    states = forget(states, (path) => path.startsWith('/collection/a'))
    expect(states.explore.stack).toEqual(['/'])
  })
})

describe('the session', () => {
  afterEach(() => sessionStorage.clear())

  it('is read back from session storage, and anything unreadable ignored', () => {
    const saved = {
      ...emptyStates(),
      captures: {
        root: '/captures',
        stack: ['/captures', '/captures/1'],
        scroll: 120,
      },
      relations: { root: 3, stack: [], scroll: 0 },
    }
    sessionStorage.setItem('midden.tabs', JSON.stringify(saved))
    const states = readStates()
    expect(states.captures).toEqual(saved.captures)
    expect(states.relations).toEqual(emptyStates().relations)
    sessionStorage.setItem('midden.tabs', '{')
    expect(readStates()).toEqual(emptyStates())
  })
})

describe('following the router', () => {
  const view = defineComponent({ render: () => null })
  let router: Router
  async function start(path: string) {
    sessionStorage.clear()
    tabStates.value = emptyStates()
    location.hash = path
    router = createRouter({
      history: createWebHashHistory(),
      routes: [
        { path: '/', name: 'collections', component: view },
        { path: '/collection/:id', name: 'collection', component: view },
        { path: '/captures', name: 'captures', component: view },
        { path: '/captures/:id', name: 'capture', component: view },
      ],
    })
    trackTabs(router)
    await router.push(path)
    await router.isReady()
  }
  /** Wait for a step through history to arrive. */
  const arrived = (path: string) =>
    new Promise<void>((resolve) => {
      const stop = router.afterEach((to) => {
        if (to.fullPath !== path) return
        stop()
        resolve()
      })
    })

  it('returns to the tab as it was left, and 返回 within it', async () => {
    await start('/')
    await router.push('/collection/a')
    // Another tab, then the bar's link back.
    await router.push({ path: '/captures', state: SWITCH_STATE })
    await router.push('/captures/1')
    expect(lastPage(tabStates.value, 'captures')).toBe('/captures/1')
    await router.push({ path: '/collection/a', state: SWITCH_STATE })
    expect(tabStates.value.explore.stack).toEqual(['/', '/collection/a'])
    // History holds 采集 behind it; 返回 goes to 探索's root instead,
    // in place, and the browser's back still reaches 采集.
    expect(router.options.history.state.back).toBe('/captures/1')
    expect(backRoute(router)).toBe('/')
    goBack(router)
    await arrived('/')
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(router.options.history.state.back).toBe('/captures/1')
    // Without a switch, 返回 is a step back through history.
    await router.push('/collection/b')
    expect(backRoute(router)).toBe('/')
    const back = arrived('/')
    goBack(router)
    await back
    expect(tabStates.value.explore.stack).toEqual(['/'])
    // Saved for the session.
    expect(
      JSON.parse(sessionStorage.getItem('midden.tabs')!).captures.stack,
    ).toEqual(['/captures', '/captures/1'])
  })
})
