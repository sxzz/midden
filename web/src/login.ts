import { APIError, call, client, errorText } from './api'

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
    await call(client.auth.telegram.$post({ json: { login } }))
    return ''
  } catch (e) {
    // A failed check is the server's 401, which errorText reads as an
    // expired session.
    return e instanceof APIError && e.status === 401 ? e.message : errorText(e)
  }
}
