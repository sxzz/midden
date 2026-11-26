/**
 * The app's addresses are plain paths under its base (`/app/`), as
 * `/app/captures/watches`; the server and Cloudflare answer any of them
 * with the app. The fragment is left to what must never reach a server: a
 * passkey link's token (`/app/passkey#<token>`), and the Mini App's launch
 * data that Telegram appends (`#tgWebAppData=…`).
 */
export const BASE = import.meta.env.BASE_URL
const LEADING_SLASH = /^\//
const OLD_PASSKEY = /^\/passkey\/([\w-]+)$/

/** The address of a route path (`/captures`), as a link writes it. */
export function appHref(path: string) {
  return BASE + path.replace(LEADING_SLASH, '')
}

/** The route path of an address of this app, or undefined for another. */
export function appPath(href: string): string | undefined {
  return href.startsWith(BASE) ? `/${href.slice(BASE.length)}` : undefined
}

/**
 * The address an old hash address (`#/…`, before the app's paths were plain)
 * means now, or undefined when the fragment is not one: Telegram's launch
 * data, say. A passkey link keeps its token in the fragment.
 */
export function legacyAddress(hash: string): string | undefined {
  if (!hash.startsWith('#/')) return undefined
  const path = hash.slice(1)
  const passkey = OLD_PASSKEY.exec(path)
  if (passkey) return `${appHref('/passkey')}#${passkey[1]}`
  return appHref(path)
}
