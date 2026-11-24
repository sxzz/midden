import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import CaptureOptions from './CaptureOptions.vue'
import type { CaptureOptions as Options } from '../api'

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})

it('asks for the lists of a profile only when 抓关系网 is turned on', async () => {
  const update = vi.fn<(value: Options) => void>()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureOptions, {
    modelValue: {},
    // Vapor reads a root prop through a getter, handlers included.
    'onUpdate:modelValue': () => update,
  })
  app.mount(el)
  unmount = () => app.unmount()
  const row = [...el.querySelectorAll('label.row')].find((label) =>
    label.textContent?.startsWith('抓关系网'),
  )!
  const toggle = row.querySelector('input')!
  expect(toggle.checked).toBe(false)
  expect(el.querySelector('.summary')?.textContent).toBe('全部采集')

  toggle.click()
  await nextTick()
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ relations: true }),
  )
  expect(el.querySelector('.summary')?.textContent).toBe('抓关系网')

  toggle.click()
  await nextTick()
  expect(update.mock.lastCall?.[0].relations).toBeUndefined()
})
