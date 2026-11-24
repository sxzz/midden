import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick, shallowRef } from 'vue'
import { mockApi, type Request } from '../testing/api'
import UpdateSheet from './UpdateSheet.vue'
import type { UpdatePreview, UpdateTarget } from '../api'

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
  vi.stubGlobal('crypto', { randomUUID: () => 'key' })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function mount(target: UpdateTarget, preview: UpdatePreview) {
  const sent: unknown[] = []
  mockApi((path, request: Request) => {
    if (path === '/updates/preview') return preview
    if (path === '/updates') {
      sent.push(JSON.parse(request.body!))
      return { id: 'record' }
    }
    throw new Error(`unexpected ${path}`)
  })
  const started: string[] = []
  const open = shallowRef(false)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(UpdateSheet, {
    open: () => open.value,
    target: () => target,
    // Vapor reads a root prop through a getter, handlers included.
    onStarted: () => (id: string) => started.push(id),
  })
  app.mount(el)
  unmount = () => app.unmount()
  open.value = true
  await nextTick()
  await vi.waitFor(() =>
    expect(el.querySelector('.action.strong')?.hasAttribute('disabled')).toBe(
      false,
    ),
  )
  const label = (text: string) =>
    [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(text),
    )
  const toggle = async (text: string) => {
    label(text)!.querySelector('input')!.click()
    await nextTick()
  }
  const start = async () => {
    el.querySelector<HTMLButtonElement>('.action.strong')!.click()
    await vi.waitFor(() => expect(started).toHaveLength(1))
  }
  return { el, sent, started, label, toggle, start }
}

const defaults = {
  posts: 'latest',
  count: 100,
  media_only: false,
  include_shared: true,
  capture_references: true,
  relations: false,
}

it('a folder: what it covers as the title, every option when it has profiles', async () => {
  const { el, sent, label, toggle, start } = await mount(
    { target: 'folder', id: 'folder' },
    { posts: 340, profiles: 12, listable: 12, name: '猫' },
  )
  expect(el.querySelector('.head')?.textContent).toBe(
    '更新 12 个账号、340 条帖子',
  )
  // The link form's options, with the same defaults.
  expect(label('抓帖子')!.querySelector('input')!.checked).toBe(true)
  expect(label('帖子范围')!.querySelector('select')!.value).toBe('latest')
  expect(label('条数')!.querySelector('input')!.value).toBe('100')
  expect(label('发帖日期')).toBeDefined()
  expect(label('仅采集含图片或视频的帖子')).toBeDefined()
  expect(label('包含引用转帖和纯转发')).toBeDefined()
  expect(label('采集引用、转发的原帖')).toBeDefined()
  expect(label('抓关系网')!.querySelector('input')!.checked).toBe(false)
  // Sub-options show only under a checked parent.
  await toggle('抓帖子')
  expect(label('帖子范围')).toBeUndefined()
  expect(label('仅采集含图片或视频的帖子')).toBeUndefined()
  await toggle('抓帖子')
  const scope = label('帖子范围')!.querySelector('select')!
  scope.value = 'until_existing'
  scope.dispatchEvent(new Event('change'))
  await nextTick()
  await toggle('仅采集含图片或视频的帖子')
  await toggle('抓关系网')
  await start()
  expect(sent).toEqual([
    {
      target: { target: 'folder', id: 'folder' },
      options: {
        ...defaults,
        posts: 'until_existing',
        count: undefined,
        media_only: true,
        relations: true,
      },
    },
  ])
})

it('posts alone have only their references; profiles without lists no 抓关系网', async () => {
  const posts = await mount(
    { target: 'many', ids: ['a', 'b'] },
    { posts: 2, profiles: 0, listable: 0 },
  )
  expect(posts.el.querySelector('.head')?.textContent).toBe('更新 2 条帖子')
  expect(posts.label('抓帖子')).toBeUndefined()
  expect(posts.label('抓关系网')).toBeUndefined()
  await posts.toggle('采集引用、转发的原帖')
  await posts.start()
  expect(posts.sent).toEqual([
    {
      target: { target: 'many', ids: ['a', 'b'] },
      options: { ...defaults, capture_references: false },
    },
  ])
  unmount()
  document.body.replaceChildren()

  const profiles = await mount(
    { target: 'many', ids: ['p'] },
    { posts: 0, profiles: 1, listable: 0 },
  )
  // A platform without lists offers no 抓关系网.
  expect(profiles.label('抓关系网')).toBeUndefined()
  // Without a single post, the references follow the posts.
  await profiles.toggle('抓帖子')
  expect(profiles.label('采集引用、转发的原帖')).toBeUndefined()
  await profiles.start()
  expect(profiles.sent).toEqual([
    {
      target: { target: 'many', ids: ['p'] },
      options: { ...defaults, posts: 'none', count: undefined },
    },
  ])
})
