import { computed, shallowRef } from 'vue'
import { host } from '../host'

/**
 * 添加到桌面 (设置 → 账号): Chrome and Edge install the app from its
 * manifest when it asks (`beforeinstallprompt`); Safari on an iPhone or
 * iPad has no such prompt, so it downloads a profile that puts the app on
 * the home screen (scripts/web-clip.ts). Nowhere else, inside Telegram, or
 * once the app is installed or opened as one, is there anything to offer.
 */

/** Chrome's install prompt, kept to be shown when the reader asks. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<{ outcome: 'accepted' | 'dismissed' } | undefined>
}

/** iOS's home screen profile, served beside the app. */
export const PROFILE_PATH = '/midden.mobileconfig'

const prompt = shallowRef<InstallPromptEvent>()
const installed = shallowRef(false)
let watching = false

/**
 * Keep Chrome's prompt and hear when the app is installed. Call once at
 * start: the prompt comes when the browser decides, before 设置 is opened.
 */
export function watchInstall() {
  if (watching) return
  watching = true
  addEventListener('beforeinstallprompt', (event) => {
    // The browser's own banner is left to the row.
    event.preventDefault()
    prompt.value = event as InstallPromptEvent
  })
  addEventListener('appinstalled', () => {
    installed.value = true
    prompt.value = undefined
  })
}

/** Opened as an installed app: from a desktop, a home screen or a Web Clip. */
export function isStandalone() {
  return (
    !!globalThis.matchMedia?.('(display-mode: standalone)').matches ||
    !!globalThis.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

const IOS = /\b(?:iPhone|iPad|iPod)\b/
const MAC = /\bMacintosh\b/
// Safari says its version; an app's own web view does not.
const SAFARI = /\bVersion\/[\d.]+ (?:\S+ )*Safari\//
const OTHER_BROWSER = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//
/**
 * Safari on an iPhone or iPad, which installs a profile. An iPad asks for
 * desktop pages as a Mac, told apart by its touch screen. Other iOS
 * browsers (CriOS, FxiOS, EdgiOS) and in-app views can't install one.
 */
export function isIosSafari(
  ua = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
) {
  const ios = IOS.test(ua) || (MAC.test(ua) && touchPoints > 1)
  return ios && SAFARI.test(ua) && !OTHER_BROWSER.test(ua)
}

export function useInstall() {
  const browser = !host()?.initData && !isStandalone() && !installed.value
  const ios = browser && isIosSafari()
  /** How this browser adds the app: its prompt, a profile, or not at all. */
  const way = computed<'prompt' | 'profile' | undefined>(() => {
    if (!browser || installed.value) return
    if (prompt.value) return 'prompt'
    if (ios) return 'profile'
  })
  /** Show Chrome's prompt; it can be shown once, so it is let go. */
  async function install() {
    const event = prompt.value
    if (!event) return
    prompt.value = undefined
    const choice = await event.prompt()
    if (choice?.outcome === 'accepted') installed.value = true
  }
  return { way, install }
}
