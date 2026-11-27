import { afterEach, expect, it } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { date } from '../presentation'
import RevisionTimeline from './RevisionTimeline.vue'

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})

// Newest first, as the API pages them; the older two differ only in counts.
const points = [
  { capture_id: 'c3', observed_at: '2026-03-01T00:00:00Z', revision_id: 'r2' },
  { capture_id: 'c2', observed_at: '2026-02-01T00:00:00Z', revision_id: 'r1' },
  { capture_id: 'c1', observed_at: '2026-01-01T00:00:00Z', revision_id: 'r1' },
]

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.append(el)
  const selected: string[] = []
  const more: unknown[] = []
  const app = createVaporApp(RevisionTimeline, {
    points,
    selectedId: 'c3',
    latestId: 'c3',
    more: false,
    label: '资料版本',
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

it('runs from the oldest point on the left to the newest', async () => {
  const { el, range, drag, selected } = mount({})
  expect(range.max).toBe('2')
  expect(range.value).toBe('2')
  expect(el.textContent).toContain('最新版本')
  expect(el.textContent).toContain(date(points[0]!.observed_at))
  drag(0)
  drag(0)
  drag(1)
  await nextTick()
  // Each point passed is asked for once, even two on the same revision;
  // resting on one repeats nothing.
  expect(selected).toEqual(['c1', 'c2'])
  expect(el.textContent).toContain('第2 / 3次')
  expect(el.textContent).toContain(date(points[1]!.observed_at))
})

it('starts at the point shown', () => {
  const { el, range } = mount({ selectedId: 'c1' })
  expect(range.value).toBe('0')
  expect(el.textContent).toContain('第1 / 3次')
})

it('asks for older points when resting on the oldest one loaded', () => {
  const { el, range, drag, more } = mount({ more: true })
  expect(el.textContent).toContain('更早的记录')
  drag(0)
  range.dispatchEvent(new Event('change'))
  expect(more).toHaveLength(1)
})
