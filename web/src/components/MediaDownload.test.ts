import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { api } from '../api'
import { host } from '../host'
import MediaDownload from './MediaDownload.vue'
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))
vi.mock('../host', () => ({ host: vi.fn() }))
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
})
function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(MediaDownload, {
    asset: {
      id: 'video-1',
      state: 'ready',
      mime: 'video/mp4',
      sensitive: false,
    },
  })
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
function click(el: HTMLElement) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  el.querySelector('a')!.dispatchEvent(event)
  return event
}
it('hands the authorized URL to Telegram and suppresses browser navigation', async () => {
  const downloadFile = vi.fn()
  vi.mocked(host).mockReturnValue({
    initData: 'fixture',
    isVersionAtLeast: () => true,
    downloadFile,
  } as unknown as ReturnType<typeof host>)
  const params = {
    url: 'https://collection.test/v1/downloads/video-1?signature=fixture',
    file_name: 'video-1.mp4',
  }
  vi.mocked(api).mockResolvedValue(params)
  const el = mount()
  expect(click(el).defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledWith(params))
  expect(api).toHaveBeenCalledWith('/assets/video-1/download', {
    method: 'POST',
  })
})
it('shows download errors and allows retry', async () => {
  const downloadFile = vi.fn()
  vi.mocked(host).mockReturnValue({
    initData: 'fixture',
    isVersionAtLeast: () => true,
    downloadFile,
  } as unknown as ReturnType<typeof host>)
  vi.mocked(api).mockRejectedValue(new Error('下载失败'))
  const el = mount()
  click(el)
  await vi.waitFor(() =>
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('下载失败'),
  )
  expect(downloadFile).not.toHaveBeenCalled()
  click(el)
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2))
})
it('keeps a normal download link outside Telegram', () => {
  const el = mount()
  expect(el.querySelector('a')?.getAttribute('href')).toBe('/v1/assets/video-1')
  expect(api).not.toHaveBeenCalled()
})
