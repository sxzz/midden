import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { host } from '../host'
import MediaDownload from './MediaDownload.vue'
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
      url: '/media/abc?t=video%2Fmp4&s=x',
      download_url: '/media/abc?t=video%2Fmp4&n=video-1.mp4&s=y',
      file_name: 'video-1.mp4',
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
function inTelegram(downloadFile: (params: unknown) => void) {
  vi.mocked(host).mockReturnValue({
    initData: 'fixture',
    isVersionAtLeast: () => true,
    downloadFile,
  } as unknown as ReturnType<typeof host>)
}
it('hands the signed download link to Telegram and suppresses navigation', () => {
  const downloadFile = vi.fn()
  inTelegram(downloadFile)
  const el = mount()
  expect(click(el).defaultPrevented).toBe(true)
  expect(downloadFile).toHaveBeenCalledWith({
    url: new URL('/media/abc?t=video%2Fmp4&n=video-1.mp4&s=y', location.href)
      .href,
    file_name: 'video-1.mp4',
  })
})
it('shows download errors', async () => {
  inTelegram(() => {
    throw new Error('下载失败')
  })
  const el = mount()
  click(el)
  await vi.waitFor(() =>
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('下载失败'),
  )
})
it('keeps a normal download link outside Telegram', () => {
  const el = mount()
  expect(el.querySelector('a')?.getAttribute('href')).toBe(
    '/media/abc?t=video%2Fmp4&n=video-1.mp4&s=y',
  )
})
