import { afterEach, describe, expect, it } from 'vitest'
import { createVaporApp, nextTick, shallowRef } from 'vue'
import {
  defaultOptions,
  optionsSummary,
  type Options,
} from '../capture-options'
import CaptureOptions from './CaptureOptions.vue'

let unmount = () => {}
afterEach(() => {
  unmount()
  unmount = () => {}
  document.body.replaceChildren()
})

function mount(props: Record<string, unknown> = {}) {
  const model = shallowRef<Options>(defaultOptions())
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureOptions, {
    // Vapor reads a root prop through a getter, handlers included.
    modelValue: () => model.value,
    'onUpdate:modelValue': () => (value: Options) => (model.value = value),
    ...Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, () => value]),
    ),
  })
  app.mount(el)
  unmount = () => app.unmount()
  const row = (text: string) =>
    [...el.querySelectorAll('label.row')].find((label) =>
      label.textContent?.trim().startsWith(text),
    )
  const toggle = async (text: string) => {
    row(text)!.querySelector('input')!.click()
    await nextTick()
  }
  const choose = async (text: string, value: string) => {
    const select = row(text)!.querySelector('select')!
    select.value = value
    select.dispatchEvent(new Event('change'))
    await nextTick()
  }
  const labels = () =>
    [...el.querySelectorAll('label.row')].map((label) =>
      label.firstElementChild!.firstChild!.textContent?.trim(),
    )
  return { el, model, row, toggle, choose, labels }
}

describe('on the link form', () => {
  it('folds under a summary of what differs from the defaults', async () => {
    const { el, model, toggle, choose } = mount({ collapsible: true })
    const summary = () => el.querySelector('.summary')?.textContent
    expect(el.querySelector('details')).not.toBeNull()
    expect(summary()).toBe('最新 100 条')
    await toggle('仅采集含图片或视频的帖子')
    await choose('发帖日期', '7')
    await toggle('抓关系网')
    expect(summary()).toBe('仅媒体 · 最近 7 天 · 抓关系网')
    expect(model.value).toEqual({
      ...defaultOptions(),
      media_only: true,
      since_days: 7,
      relations: true,
    })
    await choose('帖子范围', 'until_existing')
    expect(model.value).not.toHaveProperty('count')
    expect(summary()).toBe('抓到已有数据为止 · 仅媒体 · 最近 7 天 · 抓关系网')
  })

  it('a number for the newest and at most; all needs none', async () => {
    const { el, model, row, choose } = mount({ collapsible: true })
    const count = () => row('条数')?.querySelector('input')
    expect(count()?.value).toBe('100')
    await choose('帖子范围', 'max')
    count()!.value = '250'
    count()!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(model.value).toMatchObject({ posts: 'max', count: 250 })
    expect(el.querySelector('.summary')?.textContent).toBe('最多 250 条')
    await choose('帖子范围', 'all')
    expect(count()).toBeUndefined()
    expect(model.value.posts).toBe('max')
    expect(model.value).not.toHaveProperty('count')
    expect(el.querySelector('.summary')?.textContent).toBe('全部帖子')
  })
})

describe('in the update sheet', () => {
  it("shows a profile's sub-options only while 抓帖子 is on", async () => {
    const { model, toggle, labels } = mount({ posts: false })
    expect(labels()).toEqual([
      '抓帖子',
      '帖子范围',
      '条数',
      '发帖日期',
      '仅采集含图片或视频的帖子',
      '包含引用转帖和纯转发',
      '采集引用、转发的原帖',
      '抓关系网',
    ])
    await toggle('抓帖子')
    expect(model.value.posts).toBe('none')
    expect(labels()).toEqual(['抓帖子', '抓关系网'])
    // Back on, with the scope it had.
    await toggle('抓帖子')
    expect(model.value).toMatchObject({ posts: 'latest', count: 100 })
  })

  it('a single post has only its references', () => {
    const { labels } = mount({ profiles: false })
    expect(labels()).toEqual(['采集引用、转发的原帖'])
  })

  it('no 抓关系网 where no list can be read, and the sizes where they can', () => {
    expect(mount({ relations: false }).labels()).not.toContain('抓关系网')
    unmount()
    const { row } = mount({ relationsHint: '关注 2 · 粉丝 6000' })
    expect(row('抓关系网')?.querySelector('.hint')?.textContent).toBe(
      '关注 2 · 粉丝 6000',
    )
  })

  it('is not collapsible there', () => {
    const { el } = mount()
    expect(el.querySelector('details')).toBeNull()
    expect(el.querySelector('summary')).toBeNull()
  })
})

describe('summary', () => {
  const all = { profiles: true, posts: true }
  it('names what applies to the target', () => {
    const options = {
      ...defaultOptions(),
      posts: 'none' as const,
      media_only: true,
      capture_references: false,
      relations: true,
    }
    expect(optionsSummary(options, all)).toBe('不抓帖子 · 不抓原帖 · 抓关系网')
    expect(optionsSummary(options, { profiles: true, posts: false })).toBe(
      '不抓帖子 · 抓关系网',
    )
    expect(optionsSummary(options, { profiles: false, posts: true })).toBe(
      '不抓原帖',
    )
    expect(
      optionsSummary(defaultOptions(), { profiles: false, posts: true }),
    ).toBe('')
    expect(
      optionsSummary(
        { ...defaultOptions(), include_shared: false, count: 20 },
        all,
      ),
    ).toBe('最新 20 条 · 不含转帖')
  })
})
