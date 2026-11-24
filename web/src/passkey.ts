import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { APIError, call, client, type Passkey } from './api'

export const passkeysSupported = () => browserSupportsWebAuthn()

// The server sends the library's own options as JSON; the client's inferred
// JSON type only mangles extension inputs, which it never sets.
const request = (options: unknown) =>
  options as PublicKeyCredentialRequestOptionsJSON
const creation = (options: unknown) =>
  options as PublicKeyCredentialCreationOptionsJSON

/**
 * What to say about a failed passkey step. Closing the browser's prompt is
 * the user's choice, so it says nothing.
 */
export function passkeyError(e: unknown): string {
  if (e instanceof APIError) return e.message
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
      return '这台设备上已有本站的通行密钥。'
    if (e.code === 'ERROR_CEREMONY_ABORTED') return ''
  }
  if (e instanceof DOMException && e.name === 'NotAllowedError') return ''
  return '通行密钥不可用。'
}

/** Sign in with a passkey made for this domain; the server sets the cookie. */
export async function signInWithPasskey() {
  const options = await call(client.auth.passkey.options.$post())
  const response = await startAuthentication({ optionsJSON: request(options) })
  await call(client.auth.passkey.$post({ json: { response } }))
}

/**
 * Make a passkey for this domain: with a /passkey link's token, which also
 * signs in, or in a signed-in session.
 */
export async function createPasskey(
  name: string,
  token?: string,
): Promise<Passkey> {
  if (token) {
    const options = await call(
      client.auth.passkey.register.options.$post({ json: { token } }),
    )
    const response = await startRegistration({ optionsJSON: creation(options) })
    return call(
      client.auth.passkey.register.$post({ json: { token, name, response } }),
    )
  }
  const options = await call(client.passkeys.options.$post())
  const response = await startRegistration({ optionsJSON: creation(options) })
  return call(client.passkeys.$post({ json: { name, response } }))
}

const DEVICES: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** A name to start from: the device and browser, and the domain. */
export function defaultPasskeyName(
  userAgent = navigator.userAgent,
  host = location.host,
) {
  const pick = (list: [RegExp, string][]) =>
    list.find(([pattern]) => pattern.test(userAgent))?.[1]
  const device = [pick(DEVICES), pick(BROWSERS)].filter(Boolean).join(' ')
  return device ? `${device} · ${host}` : host
}
