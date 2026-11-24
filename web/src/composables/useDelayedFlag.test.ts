import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useDelayedFlag } from './useDelayedFlag'

afterEach(() => vi.useRealTimers())

function setup() {
  vi.useFakeTimers()
  const source = shallowRef(false)
  const scope = effectScope()
  const shown = scope.run(() => useDelayedFlag(() => source.value, 300, 600))!
  return { source, shown, stop: () => scope.stop() }
}

it('shows nothing for a quick save', async () => {
  const { source, shown, stop } = setup()
  source.value = true
  await nextTick()
  vi.advanceTimersByTime(200)
  source.value = false
  await nextTick()
  vi.advanceTimersByTime(1000)
  expect(shown.value).toBe(false)
  stop()
})

it('keeps a slow save on screen long enough to read', async () => {
  const { source, shown, stop } = setup()
  source.value = true
  await nextTick()
  vi.advanceTimersByTime(300)
  expect(shown.value).toBe(true)
  vi.advanceTimersByTime(100)
  source.value = false
  await nextTick()
  vi.advanceTimersByTime(400)
  expect(shown.value).toBe(true)
  vi.advanceTimersByTime(100)
  expect(shown.value).toBe(false)
  stop()
})
