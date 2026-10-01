import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { api, type Tag } from '../api'
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
/** Whatever carries this visible text, the way a reader would find it. */
function find(el: HTMLElement, selector: string, text: string) {
  return [...el.querySelectorAll<HTMLElement>(selector)].find(
    (node) => node.textContent?.trim() === text,
  )
}
function press(el: HTMLElement, selector: string, text: string) {
  const target = find(el, selector, text)
  if (!target) throw new Error(`no ${selector} reading “${text}”`)
  target.click()
}
/** The note's own action, which is the only thing that may write the note. */
const noteButton = (el: HTMLElement) =>
  find(el, 'button', '保存备注') as HTMLButtonElement
const checked = (el: HTMLElement, tag: string) =>
  find(el, 'label', tag)?.querySelector<HTMLInputElement>('input')?.checked
/** A request the test holds open, to observe what happens mid-flight. */
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}
it('autosaves tag creation and removal while the note waits for its button', async () => {
  const saved = vi.fn()
  const request = vi.mocked(api)
  let annotation = { note: '原备注', tags: [{ id: 'old', name: '原标签' }] }
  const sent: unknown[] = []
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return annotation.tags
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body))
      sent.push(body)
      annotation = {
        note: body.note ?? annotation.note,
        tags: body.tag_names
          ? body.tag_names.map((name: string) => ({ id: name, name }))
          : annotation.tags,
      }
    }
    return annotation
  })
  const el = mount(CollectionAnnotations, { id: 'collection', onSaved: saved })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('原备注'),
  )
  expect(noteButton(el).disabled).toBe(true)
  expect(el.textContent).not.toContain('正在保存标签…')
  // An edited note stays a draft: the tag writes below must not carry it.
  await input(el.querySelector('textarea')!, '新备注')
  await input(el.querySelector('[aria-label="新标签名称"]')!, '新标签')
  press(el, 'button', '创建')
  await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(sent).toEqual([{ tag_names: ['原标签', '新标签'] }])
  expect(annotation.note).toBe('原备注')
  expect(el.querySelector('textarea')?.value).toBe('新备注')
  expect(noteButton(el).disabled).toBe(false)
  press(el, 'label', '原标签')
  await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
  expect(annotation.tags).toEqual([{ id: '新标签', name: '新标签' }])
  expect(annotation.note).toBe('原备注')
  // Only its own action writes the note, and it writes nothing else.
  press(el, 'button', '保存备注')
  await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(3))
  expect(sent.at(-1)).toEqual({ note: '新备注' })
  expect(request).toHaveBeenCalledWith('/collections/collection/annotation', {
    method: 'PATCH',
    body: JSON.stringify({ note: '新备注' }),
  })
  expect(annotation.note).toBe('新备注')
  expect(noteButton(el).disabled).toBe(true)
})
it('allows retrying a failed tag autosave independently of the note', async () => {
  const request = vi.mocked(api)
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return [{ id: 'old', name: '原标签' }]
    return {
      note: '原备注',
      tags: options ? [] : [{ id: 'old', name: '原标签' }],
    }
  })
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('原备注'),
  )
  request.mockRejectedValueOnce(new Error('网络故障'))
  press(el, 'label', '原标签')
  await vi.waitFor(() => expect(el.textContent).toContain('网络故障'))
  expect(noteButton(el).disabled).toBe(true)
  press(el, 'button', '重试保存标签')
  await vi.waitFor(() => expect(el.textContent).not.toContain('网络故障'))
  expect(request).toHaveBeenLastCalledWith('/tags')
  expect(request).toHaveBeenCalledWith('/collections/collection/annotation', {
    method: 'PATCH',
    body: JSON.stringify({ tag_names: [] }),
  })
})
it('keeps a failed note save inside the note region', async () => {
  const request = vi.mocked(api)
  let annotation = { note: '原备注', tags: [{ id: 'old', name: '原标签' }] }
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return [{ id: 'old', name: '原标签' }]
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body))
      annotation = {
        note: body.note ?? annotation.note,
        tags: body.tag_names
          ? body.tag_names.map((name: string) => ({ id: name, name }))
          : annotation.tags,
      }
    }
    return annotation
  })
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('原备注'),
  )
  await input(el.querySelector('textarea')!, '新备注')
  request.mockRejectedValueOnce(new Error('备注写入失败'))
  press(el, 'button', '保存备注')
  await vi.waitFor(() => expect(el.textContent).toContain('备注写入失败'))
  expect(el.querySelector('textarea')?.value).toBe('新备注')
  expect(noteButton(el).disabled).toBe(false)
  // The failure belongs to the note alone: the tags offer no retry and keep
  // saving themselves, and their success does not clear the note's message.
  expect(find(el, 'button', '重试保存标签')).toBeUndefined()
  expect(el.textContent).not.toContain('正在保存标签…')
  press(el, 'label', '原标签')
  await vi.waitFor(() => expect(annotation.tags).toEqual([]))
  expect(el.textContent).toContain('备注写入失败')
  press(el, 'button', '保存备注')
  await vi.waitFor(() => expect(annotation.note).toBe('新备注'))
  expect(el.textContent).not.toContain('备注写入失败')
})
it('coalesces a burst of tag edits into the last one', async () => {
  const saved = vi.fn()
  const request = vi.mocked(api)
  const vocabulary = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
  ]
  const sent: string[][] = []
  let stored: Tag[] = []
  const open = deferred()
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return vocabulary
    if (options?.method === 'PATCH') {
      const names: string[] = JSON.parse(String(options.body)).tag_names
      sent.push(names)
      if (sent.length === 1) await open.promise
      stored = vocabulary.filter((tag) => names.includes(tag.name))
    }
    return { note: '', tags: stored }
  })
  const el = mount(CollectionAnnotations, { id: 'collection', onSaved: saved })
  await vi.waitFor(() => expect(el.textContent).toContain('甲'))
  press(el, 'label', '甲')
  await vi.waitFor(() => expect(sent).toEqual([['甲']]))
  expect(el.textContent).toContain('正在保存标签…')
  // Two more edits land while that first write is still open. They must not
  // race it, and the last one must still reach the server.
  press(el, 'label', '乙')
  press(el, 'label', '甲')
  await nextTick()
  expect(sent).toEqual([['甲']])
  open.release()
  await vi.waitFor(() => expect(sent).toEqual([['甲'], ['乙']]))
  // The write that survived ends by reloading the vocabulary, and the progress
  // notice goes away once nothing is left to drain.
  await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('/tags'))
  await vi.waitFor(() => expect(el.textContent).not.toContain('正在保存标签…'))
  expect(checked(el, '乙')).toBe(true)
  expect(checked(el, '甲')).toBe(false)
  expect(stored).toEqual([{ id: 'b', name: '乙' }])
  // Only the write that survived the burst reports a save.
  expect(saved).toHaveBeenCalledTimes(1)
})
it('restores a tag reselected while its removal was still in flight', async () => {
  const request = vi.mocked(api)
  const vocabulary = [{ id: 'a', name: '甲' }]
  const sent: string[][] = []
  let stored: Tag[] = [...vocabulary]
  const open = deferred()
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return vocabulary
    if (options?.method === 'PATCH') {
      const names: string[] = JSON.parse(String(options.body)).tag_names
      sent.push(names)
      if (sent.length === 1) await open.promise
      stored = vocabulary.filter((tag) => names.includes(tag.name))
    }
    return { note: '', tags: stored }
  })
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() => expect(checked(el, '甲')).toBe(true))
  press(el, 'label', '甲')
  await vi.waitFor(() => expect(sent).toEqual([[]]))
  // Putting the tag back mid-flight leaves the chips looking like the baseline
  // the removal started from, so the confirmed removal has to be written back
  // rather than mistaken for what the server already holds.
  press(el, 'label', '甲')
  open.release()
  await vi.waitFor(() => expect(sent).toEqual([[], ['甲']]))
  await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('/tags'))
  await vi.waitFor(() => expect(el.textContent).not.toContain('正在保存标签…'))
  expect(checked(el, '甲')).toBe(true)
  expect(stored).toEqual(vocabulary)
})
it('lets a note save and a tag autosave finish without overwriting each other', async () => {
  const request = vi.mocked(api)
  const vocabulary = [{ id: 'old', name: '原标签' }]
  let stored = { note: '原备注', tags: vocabulary as Tag[] }
  const sent: unknown[] = []
  const open = deferred()
  request.mockImplementation(async (path, options) => {
    if (path === '/tags') return vocabulary
    if (options?.method !== 'PATCH') return stored
    const body = JSON.parse(String(options.body))
    sent.push(body)
    if (body.tag_names) {
      stored = {
        ...stored,
        tags: vocabulary.filter((tag) => body.tag_names.includes(tag.name)),
      }
      return stored
    }
    // This answer was computed before the tag edit reached the server, so its
    // tags are already stale by the time the note save sees it.
    const stale = { note: body.note, tags: stored.tags }
    await open.promise
    stored = { ...stored, note: body.note }
    return stale
  })
  const el = mount(CollectionAnnotations, { id: 'collection' })
  await vi.waitFor(() =>
    expect(el.querySelector('textarea')?.value).toBe('原备注'),
  )
  await input(el.querySelector('textarea')!, '新备注')
  press(el, 'button', '保存备注')
  await vi.waitFor(() => expect(sent).toEqual([{ note: '新备注' }]))
  // The chips finish their own write while the note is still open.
  press(el, 'label', '原标签')
  await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('/tags'))
  await vi.waitFor(() => expect(el.textContent).not.toContain('正在保存标签…'))
  expect(sent).toEqual([{ note: '新备注' }, { tag_names: [] }])
  expect(checked(el, '原标签')).toBe(false)
  expect(el.textContent).toContain('正在保存备注…')
  open.release()
  await vi.waitFor(() => expect(el.textContent).not.toContain('正在保存备注…'))
  await nextTick()
  // The note's stale answer must not put the removed tag back.
  expect(checked(el, '原标签')).toBe(false)
  expect(noteButton(el).disabled).toBe(true)
  expect(el.querySelector('textarea')?.value).toBe('新备注')
  expect(stored).toEqual({ note: '新备注', tags: [] })
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
