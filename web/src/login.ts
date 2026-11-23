import { api, APIError, errorText } from './api'

/**
 * The Login Widget redirects back with its signed fields in the query. Take
 * them off the URL so they never stay in history or get bookmarked.
 */
export function takeWidgetLogin(): Record<string, string> | undefined {
  const params = new URLSearchParams(location.search)
  if (!params.has('hash') || !params.has('auth_date')) return
  // Every field Telegram sent is part of the signature; only `theme` is ours.
  const theme = params.get('theme')
  const login = Object.fromEntries(
    [...params].filter(([key]) => key !== 'theme'),
  )
  const rest = theme ? `?${new URLSearchParams({ theme })}` : ''
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${rest}${location.hash}`,
  )
  return login
}

/** Exchanges widget data for a session; returns why it failed, if it did. */
export async function widgetLogin(login: Record<string, string>) {
  try {
    await api('/auth/telegram', {
      method: 'POST',
      body: JSON.stringify({ login }),
    })
    return ''
  } catch (e) {
    return e instanceof APIError && e.status === 401
      ? 'Telegram 登录校验失败，请重试。'
      : errorText(e)
  }
}
