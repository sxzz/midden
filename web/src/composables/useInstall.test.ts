import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'
const IOS_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

let standalone = false
beforeEach(() => {
  standalone = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query === '(display-mode: standalone)',
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** A fresh module (its state is the page's), listening as main.ts has it. */
async function load({ ua = CHROME } = {}) {
  vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: 0 })
  const module = await import('./useInstall')
  module.watchInstall()
  return module
}

/** Chrome's prompt, answered with `outcome`. */
function firePrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true })
  const prompt = vi.fn(async () => ({ outcome }))
  Object.assign(event, { prompt })
  dispatchEvent(event)
  return { event, prompt }
}

it('offers nothing until Chrome has a prompt', async () => {
  const { useInstall } = await load()
  const { way } = useInstall()
  expect(way.value).toBeUndefined()
  const { event } = firePrompt()
  expect(event.defaultPrevented).toBe(true)
  expect(way.value).toBe('prompt')
})

it('keeps a prompt that came before 设置 was opened', async () => {
  const { useInstall } = await load()
  firePrompt()
  expect(useInstall().way.value).toBe('prompt')
})

it('shows the prompt once, and is done when it is accepted', async () => {
  const { useInstall } = await load()
  const { prompt } = firePrompt('accepted')
  const { way, install } = useInstall()
  await install()
  expect(prompt).toHaveBeenCalledOnce()
  expect(way.value).toBeUndefined()
  // Installed: a later prompt is not offered.
  firePrompt()
  expect(way.value).toBeUndefined()
})

it('lets a dismissed prompt go, offering the next one the browser sends', async () => {
  const { useInstall } = await load()
  firePrompt('dismissed')
  const { way, install } = useInstall()
  await install()
  expect(way.value).toBeUndefined()
  firePrompt()
  expect(way.value).toBe('prompt')
})

it('hides once the app is installed', async () => {
  const { useInstall } = await load()
  firePrompt()
  const { way } = useInstall()
  dispatchEvent(new Event('appinstalled'))
  expect(way.value).toBeUndefined()
})

it('offers nothing in an installed app', async () => {
  standalone = true
  const { useInstall } = await load()
  firePrompt()
  expect(useInstall().way.value).toBeUndefined()
})

it('offers nothing inside Telegram', async () => {
  vi.stubGlobal('Telegram', { WebApp: { initData: 'signed' } })
  const { useInstall } = await load({ ua: IPHONE })
  firePrompt()
  expect(useInstall().way.value).toBeUndefined()
})

it("offers Safari's profile on an iPhone, and nothing in its home screen app", async () => {
  // Telegram's script in a browser: no launch data, not the Mini App.
  vi.stubGlobal('Telegram', { WebApp: { initData: '' } })
  const { useInstall } = await load({ ua: IPHONE })
  expect(useInstall().way.value).toBe('profile')
  vi.stubGlobal('navigator', { userAgent: IPHONE, standalone: true })
  expect(useInstall().way.value).toBeUndefined()
})

it('tells Safari on an iPhone or iPad from other browsers', async () => {
  const { isIosSafari } = await load()
  expect(isIosSafari(IPHONE, 5)).toBe(true)
  expect(isIosSafari(IPAD_DESKTOP, 5)).toBe(true)
  // A Mac: no touch screen.
  expect(isIosSafari(IPAD_DESKTOP, 0)).toBe(false)
  expect(isIosSafari(IOS_CHROME, 5)).toBe(false)
  expect(isIosSafari(IOS_WEBVIEW, 5)).toBe(false)
  expect(isIosSafari(CHROME, 0)).toBe(false)
})
