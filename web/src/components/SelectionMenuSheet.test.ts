import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, vaporInteropPlugin } from 'vue'
import { mockApi } from '../testing/api'
import SelectionMenuSheet from './SelectionMenuSheet.vue'

const keys = ['x/x.profile/1', 'x/x.profile/2', 'x/x.profile/3']
let api: ReturnType<typeof mockApi>
let unmount = () => {}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function open(profiles: string[], withData: string[]) {
  api = mockApi((path) => {
    const asked = new URLSearchParams(path.split('?', 2)[1]).getAll('rel_of')
    return {
      items: asked.map((id) => ({
        id,
        following: {},
        followers: {},
        ...(withData.includes(id) ? {} : { no_data: true }),
      })),
    }
  })
  const state = reactive({ open: false, count: profiles.length + 1, profiles })
  const compare = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({
    render: () => h(SelectionMenuSheet, { ...state, onCompare: compare }),
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  state.open = true
  await nextTick()
  return { el, compare }
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  )

it('compares the selected accounts that have relation data, saying how many are left out', async () => {
  const { el, compare } = await open(keys, [keys[0]!, keys[2]!])
  await vi.waitFor(() => expect(button(el, '比较关系')).toBeDefined())
  expect(api.mock.calls[0]![0]).toBe(
    `/collections/perspectives?${keys.map((k) => `rel_of=${encodeURIComponent(k)}`).join('&')}`,
  )
  expect(button(el, '比较关系')!.textContent).toContain(
    '2 个账号，1 个没有关系数据',
  )
  button(el, '比较关系')!.click()
  expect(compare).toHaveBeenCalledWith([keys[0], keys[2]])
})

it('offers no comparison with fewer than two accounts with data', async () => {
  const { el } = await open(keys, [keys[1]!])
  await vi.waitFor(() => expect(api).toHaveBeenCalled())
  await nextTick()
  expect(button(el, '比较关系')).toBeUndefined()
  expect(button(el, '删除媒体')).toBeDefined()
})

it('asks nothing for a single account', async () => {
  const { el } = await open([keys[0]!], [keys[0]!])
  await nextTick()
  expect(api).not.toHaveBeenCalled()
  expect(button(el, '比较关系')).toBeUndefined()
})
