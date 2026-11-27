import { useDark } from '@vueuse/core'
import { shallowRef, watch, type WritableComputedRef } from 'vue'

/**
 * Light or dark, as the class `dark` on <html>, which style.css and the
 * components key their dark colours on. In a browser the reader may choose
 * (the rail's button, 设置's 深色模式): `useDark` keeps the choice in local
 * storage, as `auto` when it equals the system's, so the page follows the
 * system until the reader picks the other one. index.html applies the
 * stored choice before the first paint. Inside Telegram the client's theme
 * rules (host.ts) and there is no choice to offer; nor while `?theme=`
 * forces one for a review.
 */
export const STORAGE_KEY = 'midden.theme'

/** The reader's choice, when there is one to make; see `startTheme`. */
export const darkTheme = shallowRef<WritableComputedRef<boolean>>()

/** Start following the reader's choice. Call once, outside Telegram. */
export function startTheme() {
  if (darkTheme.value) return
  const dark = useDark({ storageKey: STORAGE_KEY })
  darkTheme.value = dark
  // The browser's own chrome (the address bar on a phone) takes the page's.
  watch(
    dark,
    () => {
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )
      if (meta) meta.content = getComputedStyle(document.body).backgroundColor
    },
    { immediate: true, flush: 'post' },
  )
}

/** Flip it: what the reader asked for. */
export function toggleTheme() {
  const dark = darkTheme.value
  if (dark) dark.value = !dark.value
}
