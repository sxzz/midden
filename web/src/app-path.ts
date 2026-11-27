/**
 * The app's addresses are plain paths under its base (`/`), as
 * `/captures/watches`; the server and Cloudflare answer any of them with the
 * app. The fragment is left to what must never reach a server: a passkey
 * link's token (`/passkey#<token>`), and the Mini App's launch data that
 * Telegram appends (`#tgWebAppData=…`).
 */
export const BASE = import.meta.env.BASE_URL
const LEADING_SLASH = /^\//
const OLD_PASSKEY = /^\/passkey\/([\w-]+)$/
/**
 * Paths under the base that are not the app's: the API's, when it shares the
 * app's host, and the agent guide; `//host` is another site.
 */
const NOT_APP = /^\/(?:\/|(?:v1|agent|media)(?:[/?#]|$)|agent\.md(?:[?#]|$))/

/** The address of a route path (`/captures`), as a link writes it. */
export function appHref(path: string) {
  return BASE + path.replace(LEADING_SLASH, '')
}

/** The route path of an address of this app, or undefined for another. */
export function appPath(href: string): string | undefined {
  if (!href.startsWith(BASE)) return undefined
  const path = `/${href.slice(BASE.length)}`
  return NOT_APP.test(path) ? undefined : path
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
