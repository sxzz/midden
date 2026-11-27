import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import { date } from '../presentation'
import { mockApi } from '../testing/api'
import CollectionTrends from './CollectionTrends.vue'
import type { CountsSeries } from '../api'

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const at = (day: number) => `2026-11-0${day}T08:00:00.000Z`
const series: CountsSeries = {
  entity_type: 'x.profile',
  points: [
    {
      capture_id: 'c1',
      observed_at: at(1),
      counts: { '/metadata/followers': 12_000, '/metadata/statuses': 40 },
    },
    {
      capture_id: 'c2',
      observed_at: at(2),
      // Only the followers were read this time.
      counts: { '/metadata/followers': 12_500 },
    },
    {
      capture_id: 'c3',
      observed_at: at(5),
      counts: { '/metadata/followers': 12_345, '/metadata/statuses': 40 },
    },
  ],
}

async function mount(answer: unknown = series) {
  const api = mockApi(() => answer)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionTrends, { id: 'kept' })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(api).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  const charts = () =>
    [...el.querySelectorAll('.trend')].map((chart) => ({
      label: chart.querySelector('.label')?.textContent,
      value: chart.querySelector('.value')?.textContent,
      meta: chart.querySelector('.meta')?.textContent?.trim(),
    }))
  const plots = () => [...el.querySelectorAll<HTMLElement>('.plot')]
  return { el, api, charts, plots }
}

const pointer = (type: string, clientX: number) =>
  new PointerEvent(type, {
    clientX,
    bubbles: true,
    pointerType: 'touch',
    buttons: 1,
  })

it('charts each count with its newest value and its change over the captures', async () => {
  const { el, api, charts } = await mount()
  expect(api).toHaveBeenCalledWith('/collections/kept/counts', {
    method: 'GET',
    signal: expect.any(AbortSignal),
  })
  expect(el.querySelector('.summary')?.textContent).toBe(
    '3次抓取 · 11月1日 – 11月5日',
  )
  expect(charts()).toEqual([
    { label: '关注者', value: '12,345', meta: '期间 +345' },
    { label: '帖子', value: '40', meta: '期间 无变化' },
  ])
  expect(el.querySelectorAll('.trend path.line')).toHaveLength(2)
  // The table lists every capture, newest first, leaving out what one missed.
  const rows = [...el.querySelectorAll('tbody tr')].map((row) =>
    [...row.children].map((cell) => cell.textContent?.trim()),
  )
  expect(rows).toEqual([
    [date(at(5)), '12,345', '40'],
    [date(at(2)), '12,500', ''],
    [date(at(1)), '12,000', '40'],
  ])
})

it('inspects one capture on every chart that read it', async () => {
  const { el, charts, plots } = await mount()
  // The first reading sits at the plot's left edge.
  plots()[0]!.dispatchEvent(pointer('pointerdown', 0))
  await nextTick()
  expect(charts()).toEqual([
    { label: '关注者', value: '12,000', meta: date(at(1)) },
    { label: '帖子', value: '40', meta: date(at(1)) },
  ])
  expect(el.querySelectorAll('.crosshair')).toHaveLength(2)
  // Capture c2 read no statuses: that chart goes back to its newest reading.
  plots()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  await nextTick()
  expect(charts()).toEqual([
    { label: '关注者', value: '12,500', meta: date(at(2)) },
    { label: '帖子', value: '40', meta: '期间 无变化' },
  ])
  // A scroll that takes over the touch lets go, as does a tap elsewhere.
  plots()[1]!.dispatchEvent(pointer('pointercancel', 0))
  await nextTick()
  expect(charts()[0]!.value).toBe('12,345')
  plots()[1]!.dispatchEvent(pointer('pointerdown', 0))
  await nextTick()
  expect(charts()[0]!.value).toBe('12,000')
  el.querySelector('.summary')!.dispatchEvent(pointer('pointerdown', 0))
  await nextTick()
  expect(charts()[0]!.value).toBe('12,345')
  expect(el.querySelectorAll('.crosshair')).toHaveLength(0)
})

it('folds the data table behind a row that says how long it is', async () => {
  const { el } = await mount()
  const toggle = el.querySelector<HTMLButtonElement>('.table-view .toggle')!
  const sheet = el.querySelector<HTMLElement>('.table-view .sheet')!
  expect(el.querySelector('details')).toBeNull()
  expect(toggle.querySelector('.title')?.textContent).toBe('数据表')
  expect(toggle.querySelector('.rows')?.textContent).toBe('3行')
  expect(toggle.querySelector('.chevron')).not.toBeNull()
  expect(toggle.getAttribute('aria-controls')).toBe(sheet.id)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.querySelector('.chevron.open')).toBeNull()
  expect(sheet.style.display).toBe('none')
  toggle.click()
  await nextTick()
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.querySelector('.chevron.open')).not.toBeNull()
  expect(sheet.style.display).toBe('')
  toggle.click()
  await nextTick()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(sheet.style.display).toBe('none')
})

it('shows nothing when no count was read twice', async () => {
  const { el } = await mount({
    entity_type: 'x.profile',
    points: [series.points[0]],
  })
  expect(el.querySelector('.trend')).toBeNull()
  expect(el.querySelector('.summary')).toBeNull()
  expect(el.querySelector('table')).toBeNull()
})
