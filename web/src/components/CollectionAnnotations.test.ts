import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { api } from '../api'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionFilters from './CollectionFilters.vue'
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
})
function mount(
  component: Parameters<typeof createApp>[0],
  props: Record<string, unknown>,
) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(component, props).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
async function input(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
/** Click whatever carries this visible text, the way a reader would. */
function press(el: HTMLElement, selector: string, text: string) {
  const target = [...el.querySelectorAll<HTMLElement>(selector)].find(
    (node) => node.textContent?.trim() === text,
  )
  if (!target) throw new Error(`no ${selector} reading “${text}”`)
  target.click()
}
const saveButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((button) =>
    button.textContent?.trim().startsWith('保存'),
  )!
it('creates and assigns a tag with a note, preserving the draft after a failed save', async () => {
  const saved = vi.fn()
  const request = vi.mocked(api)
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return [{ id: 'old', name: '原标签' }]
    if (options?.method === 'PATCH')
      return { note: '新备注', tags: [{ id: 'new', name: '新标签' }] }
    return { note: '原备注', tags: [{ id: 'old', name: '原标签' }] }
  })
  const el = mount(CollectionAnnotations, {
    id: 'collection',
    onSaved: saved,
  })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('原备注'),
  )
  expect(saveButton(el).disabled).toBe(true)
  await input(el.querySelector('textarea')!, '新备注')
  expect(saveButton(el).disabled).toBe(false)
  await input(el.querySelector('[aria-label="新标签名称"]')!, '新标签')
  press(el, 'button', '创建')
  await vi.waitFor(() => expect(el.textContent).toContain('新标签'))
  expect(request).toHaveBeenCalledTimes(2)
  // The new tag comes selected; take the collection's original tag back off.
  press(el, 'label', '原标签')
  await nextTick()
  request.mockRejectedValueOnce(new Error('网络故障'))
  el.querySelector('form')!.dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
  await vi.waitFor(() => expect(el.textContent).toContain('网络故障'))
  expect(saved).not.toHaveBeenCalled()
  expect(el.querySelector('textarea')?.value).toBe('新备注')
  expect(saveButton(el).disabled).toBe(false)
  el.querySelector('form')!.dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith('/collections/collection/annotation', {
    method: 'PATCH',
    body: JSON.stringify({ note: '新备注', tag_names: ['新标签'] }),
  })
  await vi.waitFor(() => expect(saveButton(el).disabled).toBe(true))
})
it('sizes the note to its own text instead of a fixed box', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/tags' ? [] : { note: '第一行', tags: [] },
  )
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('第一行'),
  )
  // jsdom never lays text out, so the measurement itself is all we can see:
  // an explicit height means the note was fitted rather than left at `rows`.
  const area = el.querySelector('textarea')!
  await vi.waitFor(() => expect(area.style.height).not.toBe(''))
  area.style.height = ''
  await input(area, '第一行\n第二行')
  await vi.waitFor(() => expect(area.style.height).not.toBe(''))
})
it('asks for a first tag when the account has none', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/tags' ? [] : { note: '', tags: [] },
  )
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() => expect(el.textContent).toContain('还没有标签'))
  expect(el.querySelector('[aria-label="新标签名称"]')).not.toBeNull()
})
it('submits and clears a tag filter together with the existing filters', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/tags' ? [{ id: 'tag', name: '研究' }] : { items: [] },
  )
  const search = vi.fn()
  const el = mount(CollectionFilters, { query: 'q=test', onSearch: search })
  el.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
  await vi.waitFor(() => expect(el.textContent).toContain('研究'))
  press(el, 'label', '研究')
  await nextTick()
  expect(new URLSearchParams(search.mock.calls[0]![0]).get('tag')).toBe('tag')
  expect(new URLSearchParams(search.mock.calls[0]![0]).get('q')).toBe('test')
  press(el, 'button', '清除')
  expect(search).toHaveBeenLastCalledWith('')
  await nextTick()
  // Clearing puts the choice back on “全部”, not just in the query string.
  expect(
    el.querySelector<HTMLInputElement>('input[type="radio"]')!.checked,
  ).toBe(true)
})
