import { afterEach, expect, it } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import ProfileTimeline from './ProfileTimeline.vue'

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})

// Newest first, as the API pages them.
const revisions = [
  { id: 'r3', created_at: '2026-03-01T00:00:00Z' },
  { id: 'r2', created_at: '2026-02-01T00:00:00Z' },
  { id: 'r1', created_at: '2026-01-01T00:00:00Z' },
]

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.append(el)
  const selected: string[] = []
  const more: unknown[] = []
  const app = createVaporApp(ProfileTimeline, {
    revisions,
    selectedId: 'r3',
    latestId: 'r3',
    more: false,
    // Vapor reads function props as getters: return the handler.
    onSelect: () => (id: string) => selected.push(id),
    onMore: () => () => more.push(1),
    ...props,
  })
  app.mount(el)
  unmount = () => app.unmount()
  const range = el.querySelector<HTMLInputElement>('input[type=range]')!
  const drag = (value: number) => {
    range.value = String(value)
    range.dispatchEvent(new Event('input'))
  }
  return { el, range, drag, selected, more }
}

it('runs from the oldest revision on the left to the newest', async () => {
  const { el, range, drag, selected } = mount({})
  expect(range.max).toBe('2')
  expect(range.value).toBe('2')
  expect(el.textContent).toContain('最新版本')
  drag(0)
  drag(0)
  drag(1)
  await nextTick()
  // Each revision passed is asked for once; resting on one repeats nothing.
  expect(selected).toEqual(['r1', 'r2'])
  expect(el.textContent).toContain('第 2 / 3 个版本')
})

it('asks for older revisions when resting on the oldest one loaded', () => {
  const { range, drag, more } = mount({ more: true })
  drag(0)
  range.dispatchEvent(new Event('change'))
  expect(more).toHaveLength(1)
})
