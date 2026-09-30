interface Telegram {
  isVersionAtLeast?: (version: string) => boolean
  downloadFile?: (
    params: { url: string; file_name: string },
    callback?: (accepted: boolean) => void,
  ) => void
  initData: string
  colorScheme: string
  themeParams: Record<string, string | undefined>
  ready: () => void
  expand: () => void
  disableVerticalSwipes?: () => void
  onEvent: (name: string, fn: () => void) => void
  offEvent: (name: string, fn: () => void) => void
  BackButton: {
    show: () => void
    hide: () => void
    onClick: (fn: () => void) => void
    offClick: (fn: () => void) => void
  }
  openTelegramLink: (url: string) => void
}
declare global {
  interface Window {
    Telegram?: { WebApp: Telegram }
  }
}
export function host() {
  // eslint-disable-next-line unicorn/prefer-global-this -- The Telegram SDK augments Window.
  return window.Telegram?.WebApp
}

const HEX = /^#[\da-f]{6}$/i
type RGB = [number, number, number]
function parse(value: string): RGB {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function format(c: RGB) {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
// Perceived brightness, enough to tell a dark theme from a light one.
function brightness([r, g, b]: RGB) {
  return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255
}
// Positive amount lifts the colour toward white, negative toward black.
function shade(c: RGB, amount: number): RGB {
  const target = amount > 0 ? 255 : 0
  return c.map((v) => Math.round(v + (target - v) * Math.abs(amount))) as RGB
}
function alpha(c: RGB, value: number) {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${value})`
}

/** Maps Telegram theme parameters onto the grouped-list tokens in style.css. */
export function applyTheme(
  params: Record<string, string | undefined>,
  scheme?: string,
) {
  const root = document.documentElement
  const pick = (...keys: string[]) =>
    keys.map((key) => params[key]).find((value) => HEX.test(value || ''))
  const set = (name: string, value?: string) => {
    if (value) root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  }
  const background = pick('bg_color')
  if (!background && !scheme) return
  const base = background ? parse(background) : undefined
  const dark = base ? brightness(base) < 0.5 : scheme === 'dark'
  root.dataset.theme = dark ? 'dark' : 'light'
  const text = pick('text_color')
  set('--text', text)
  set('--subtle', pick('subtitle_text_color', 'hint_color'))
  set('--link', pick('link_color', 'accent_text_color', 'button_color'))
  set('--destructive', pick('destructive_text_color'))
  set('--separator', pick('section_separator_color'))
  if (!params.section_separator_color && text)
    set('--separator', alpha(parse(text), dark ? 0.08 : 0.11))
  if (!background || !base) return
  // Telegram's own grouped lists sit on a recessed page with raised cards.
  const secondary = pick('secondary_bg_color')
  const page =
    secondary && brightness(parse(secondary)) < brightness(base)
      ? secondary
      : dark
        ? background
        : format(shade(base, -0.05))
  const card =
    pick('section_bg_color') || (dark ? format(shade(base, 0.06)) : background)
  set('--page', page)
  set('--card', card)
  set('--fill', format(shade(parse(card), dark ? 0.07 : -0.06)))
}

export function setupHost() {
  // Lets the collection be reviewed in both schemes outside Telegram.
  const forced = new URLSearchParams(location.search).get('theme')
  if (forced === 'dark' || forced === 'light') applyTheme({}, forced)
  const tg = host()
  if (!tg?.initData) return () => {}
  const theme = () => applyTheme(tg.themeParams, tg.colorScheme)
  theme()
  tg.ready()
  tg.expand()
  tg.disableVerticalSwipes?.()
  tg.onEvent('themeChanged', theme)
  const back = () => history.back()
  tg.BackButton.onClick(back)
  return () => {
    tg.offEvent('themeChanged', theme)
    tg.BackButton.offClick(back)
  }
}
export function backButton(show: boolean) {
  const tg = host()
  if (tg?.initData) {
    if (show) tg.BackButton.show()
    else tg.BackButton.hide()
  }
}
