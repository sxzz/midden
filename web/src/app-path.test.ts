import { expect, it } from 'vitest'
import { appHref, appPath, legacyAddress } from './app-path'

it('writes route paths under the app and reads them back', () => {
  expect(appHref('/captures/watches')).toBe('/app/captures/watches')
  expect(appHref('/')).toBe('/app/')
  expect(appPath('/app/settings/admin?x=1')).toBe('/settings/admin?x=1')
  expect(appPath('https://example.test/')).toBeUndefined()
  expect(appPath('/agent.md')).toBeUndefined()
})

it('turns an old hash address into the plain one, query and all', () => {
  expect(legacyAddress('#/')).toBe('/app/')
  expect(legacyAddress('#/captures/watches?dialog=accounts')).toBe(
    '/app/captures/watches?dialog=accounts',
  )
  expect(legacyAddress('#/s/AbCdEfGhIjKlMnOpQrStUv_-/collection/1')).toBe(
    '/app/s/AbCdEfGhIjKlMnOpQrStUv_-/collection/1',
  )
})

it('keeps a passkey link’s token in the fragment', () => {
  const token = 'a'.repeat(43)
  expect(legacyAddress(`#/passkey/${token}`)).toBe(`/app/passkey#${token}`)
})

it('leaves any other fragment alone, as Telegram’s launch data', () => {
  expect(legacyAddress('#tgWebAppData=user%3D1&tgWebAppVersion=8.0')).toBe(
    undefined,
  )
  expect(legacyAddress('')).toBeUndefined()
  expect(legacyAddress('#token')).toBeUndefined()
})
