import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  h,
  KeepAlive,
  nextTick,
  vaporInteropPlugin,
  type Component,
} from 'vue'
import { mockApi } from '../testing/api'
import StorageView from './StorageView.vue'
import type { StorageReport } from '../api'

vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(component: Component) {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({
    render: () => h(KeepAlive, null, [h(component)]),
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
const titles = (el: HTMLElement) =>
  [...el.querySelectorAll('h2')].map((h2) => h2.textContent?.trim())
/** The text of each element, apart. */
function text(el: Element) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  while (walker.nextNode()) {
    const part = walker.currentNode.textContent?.replaceAll(/\s+/g, ' ').trim()
    if (part) parts.push(part)
  }
  return parts.join(' ')
}
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  )!

const GiB = 2 ** 30
const today = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

const LOCAL: StorageReport['local'] = {
  database: {
    bytes: 2.3 * GiB,
    page_size: 4096,
    pages: 600_000,
    freelist_pages: 1000,
    wal_bytes: 4 * 2 ** 20,
  },
  thumbnails: { count: 34_567, bytes: 1.2 * GiB },
  deploy_backups: { files: 1, bytes: 2.3 * GiB },
  disk: { free_bytes: 120 * GiB, total_bytes: 460 * GiB },
}
const ALERTS = { cost_usd: 5, free_disk_gb: 10, db_gb: 5, ops_percent: 80 }
const day = (d: string, bytes: number) => ({
  day: d,
  r2: {
    midden: { bytes, objects: 100, class_a: 10, class_b: 20 },
    'midden-backup': { bytes: bytes / 2, objects: 5, class_a: 3, class_b: 0 },
  },
  db_bytes: 2 * GiB,
  thumbnail_bytes: GiB,
  free_bytes: 100 * GiB,
})

const FULL: StorageReport = {
  r2: {
    fetched_at: new Date().toISOString(),
    buckets: [
      {
        name: 'midden',
        day: today,
        bytes: 40 * GiB,
        objects: 45_678,
        class_a: 12_345,
        class_b: 234_567,
      },
      {
        name: 'midden-backup',
        day: today,
        bytes: 11 * GiB,
        objects: 300,
        class_a: 30_000,
        class_b: 400,
      },
    ],
  },
  cost: {
    month: '2026-11',
    days: 26,
    storage: { used: 20, free: 10, billable: 10, usd: 0.15 },
    class_a: { used: 1_500_000, free: 1_000_000, billable: 500_000, usd: 2.25 },
    class_b: { used: 2_000_000, free: 10_000_000, billable: 0, usd: 0 },
    usd: 2.4,
  },
  local: LOCAL,
  composition: {
    computed_at: '2026-11-26T03:00:00.000Z',
    seconds: 18.2,
    total_bytes: 2.3 * GiB,
    items: [
      { name: 'revisions', type: 'table', table: 'revisions', bytes: GiB },
      {
        name: 'catalog_search',
        type: 'index',
        table: 'catalog',
        bytes: 0.5 * GiB,
      },
    ],
    rest: { count: 40, bytes: 0.8 * GiB },
    media: { files: 35_000, bytes: 1.3 * GiB },
  },
  composition_job: null,
  history: [day(yesterday, 39 * GiB), day(today, 40 * GiB)],
  alerts: ALERTS,
}

function api(report: StorageReport) {
  let alerts = { ...report.alerts }
  return mockApi((path, request) => {
    if (path.startsWith('/storage/alerts') && request.method === 'PUT') {
      alerts = { ...alerts, ...JSON.parse(request.body!) }
      return alerts
    }
    if (path.startsWith('/storage')) return { ...report, alerts }
    return
  })
}

describe('存储用量', () => {
  it('groups R2, the bill, this machine, the database, trends and thresholds', async () => {
    api(FULL)
    const el = mount(StorageView)
    await settle()
    expect(titles(el)).toEqual([
      'R2',
      '本月费用',
      '本机',
      '数据库',
      '趋势',
      '提醒阈值',
    ])
    const page = text(el)
    expect(page).toContain('midden 存储 40.0 GB 对象 45,678')
    expect(page).toContain('本月 Class A 操作 12,345 次')
    expect(page).toContain('midden-backup 存储 11.0 GB')
    expect(page).toContain('存储 20 GB·月，免费额度 10 GB·月，已用 200% $0.15')
    expect(page).toContain(
      'Class A 操作 1,500,000 次，免费额度 100 万次，已用 150% $2.25',
    )
    expect(page).toContain('免费额度 1,000 万次，已用 20% $0.00')
    expect(page).toContain('合计 $2.40')
    expect(page).toContain('可用磁盘 共 460.0 GB 120.0 GB')
    expect(page).toContain('缩略图 34,567 个 1.2 GB')
    expect(page).toContain('部署前的数据库备份 1 个文件 2.3 GB')
    expect(page).toContain('revisions 表 1.0 GB 43%')
    expect(page).toContain('catalog_search 索引 · catalog 512.0 MB')
    expect(page).toContain('其余 40 个')
    expect(page).toContain('用时 18.2 秒')
    // The largest collections are the library sorted by storage.
    const largest = [...el.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('按占用空间排列收藏'),
    )!
    expect(largest.getAttribute('href')).toBe('#/?sort=storage')
    // Each bucket's storage, the day's operations and the local figures.
    expect(
      [...el.querySelectorAll('.trend h3')].map((h) => h.textContent),
    ).toEqual([
      'R2 存储 · midden',
      'R2 存储 · midden-backup',
      'R2 Class A 操作（每天）',
      'R2 Class B 操作（每天）',
      '数据库文件',
      '缩略图',
      '可用磁盘',
    ])
    expect(
      [...el.querySelectorAll('.segments span')].map((s) => s.textContent),
    ).toEqual(['30 天', '90 天', '全部'])
  })

  it('edits the thresholds', async () => {
    const calls = api(FULL)
    const el = mount(StorageView)
    await settle()
    const rows = [...el.querySelectorAll('section')]
      .find((s) => s.querySelector('h2')?.textContent === '提醒阈值')!
      .querySelectorAll('button')
    expect([...rows].map(text)).toEqual([
      '本月 R2 费用超过 $5',
      'R2 操作次数超过免费额度的 80%',
      '可用磁盘低于 10 GB',
      '数据库文件超过 5 GB',
    ])
    button(el, '本月 R2 费用超过').click()
    await settle()
    const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
    expect(input.value).toBe('5')
    expect(input.inputMode).toBe('decimal')
    input.value = '0'
    input.dispatchEvent(new Event('input'))
    el.querySelector<HTMLFormElement>('dialog[open] form')!.requestSubmit()
    await settle()
    expect(text(el.querySelector('dialog[open]')!)).toContain(
      '数值，0.01 到 10,000',
    )
    input.value = '7.5'
    input.dispatchEvent(new Event('input'))
    el.querySelector<HTMLFormElement>('dialog[open] form')!.requestSubmit()
    await settle()
    expect(calls).toHaveBeenCalledWith(
      '/storage/alerts',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ cost_usd: 7.5 }),
      }),
    )
    expect(el.querySelector('dialog[open]')).toBeNull()
    expect(text(button(el, '本月 R2 费用超过'))).toContain('$7.5')

    button(el, '超过免费额度的').click()
    await settle()
    const percent = el.querySelector<HTMLInputElement>('dialog[open] input')!
    expect(percent.inputMode).toBe('numeric')
    percent.value = '90.5'
    percent.dispatchEvent(new Event('input'))
    el.querySelector<HTMLFormElement>('dialog[open] form')!.requestSubmit()
    await settle()
    expect(text(el.querySelector('dialog[open]')!)).toContain('整数，1 到 100')
  })

  it('shows only the local parts without the analytics', async () => {
    api({ ...FULL, r2: null, cost: null })
    const el = mount(StorageView)
    await settle()
    expect(titles(el)).toEqual(['本机', '数据库', '趋势', '提醒阈值'])
    expect(text(el)).not.toContain('R2')
    expect(
      [...el.querySelectorAll('.trend h3')].map((h) => h.textContent),
    ).toEqual(['数据库文件', '缩略图', '可用磁盘'])
    expect(
      [...el.querySelectorAll('section:last-of-type button')].map(text),
    ).toEqual(['可用磁盘低于 10 GB', '数据库文件超过 5 GB'])
  })

  it('leaves out what has not been read yet', async () => {
    api({
      ...FULL,
      r2: null,
      cost: null,
      composition: null,
      history: [day(today, GiB)],
    })
    const el = mount(StorageView)
    await settle()
    expect(titles(el)).toEqual(['本机', '提醒阈值'])
    expect(text(el)).not.toContain('媒体目录')
  })

  it('refreshes the analytics on request', async () => {
    const calls = api(FULL)
    const el = mount(StorageView)
    await settle()
    button(el, '刷新').click()
    await settle()
    expect(calls).toHaveBeenLastCalledWith(
      '/storage?refresh=1',
      expect.anything(),
    )
  })

  it('says when the database was counted, and counts again on request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-11-26T06:00:00.000Z'))
    let report = FULL
    const calls = mockApi((path, request) => {
      if (path === '/storage/composition' && request.method === 'POST')
        return (report = {
          ...report,
          composition_job: {
            state: 'queued',
            at: new Date().toISOString(),
          },
        }).composition_job
      if (path.startsWith('/storage')) return report
      return
    })
    const el = mount(StorageView)
    await settle()
    // Three hours after the reading.
    expect(text(el)).toContain('统计于3 小时前')
    expect(button(el, '重新统计').disabled).toBe(false)

    button(el, '重新统计').click()
    await settle()
    expect(calls).toHaveBeenCalledWith(
      '/storage/composition',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(button(el, '统计中…').disabled).toBe(true)
    expect(text(el)).not.toContain('重新统计')

    // While it runs the page looks again; when the request is gone it shows
    // the new reading.
    report = {
      ...report,
      composition_job: { state: 'running', at: new Date().toISOString() },
    }
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(button(el, '统计中…').disabled).toBe(true)
    report = {
      ...report,
      composition_job: null,
      composition: {
        ...report.composition!,
        computed_at: new Date().toISOString(),
        seconds: 1.5,
      },
    }
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(button(el, '重新统计').disabled).toBe(false)
    expect(text(el)).toContain('统计于不到 1 分钟前')
    expect(text(el)).toContain('用时 1.5 秒')
    const reads = calls.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.mock.calls.length).toBe(reads)
    vi.useRealTimers()
  })

  it('shows a reading under way when the page is opened', async () => {
    mockApi((path) =>
      path.startsWith('/storage')
        ? {
            ...FULL,
            composition_job: {
              state: 'running',
              at: new Date().toISOString(),
            },
          }
        : undefined,
    )
    const el = mount(StorageView)
    await settle()
    expect(button(el, '统计中…').disabled).toBe(true)
  })
})
