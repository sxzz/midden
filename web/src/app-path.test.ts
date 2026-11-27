import { expect, it } from 'vitest'
import { appHref, appPath, legacyAddress } from './app-path'

it('writes route paths under the app and reads them back', () => {
  expect(appHref('/captures/watches')).toBe('/captures/watches')
  expect(appHref('/')).toBe('/')
  expect(appPath('/settings/admin?x=1')).toBe('/settings/admin?x=1')
  expect(appPath('https://example.test/')).toBeUndefined()
  expect(appPath('/agent.md')).toBeUndefined()
})

it('leaves the server’s own paths and other sites to the browser', () => {
  for (const href of [
    '/media/ab/cd/x?e=1',
    '/v1/collections',
    '/agent/v1/whoami',
    '//example.test/',
  ])
    expect(appPath(href)).toBeUndefined()
  expect(appPath('/mediathek')).toBe('/mediathek')
})

it('turns an old hash address into the plain one, query and all', () => {
  expect(legacyAddress('#/')).toBe('/')
  expect(legacyAddress('#/captures/watches?dialog=accounts')).toBe(
    '/captures/watches?dialog=accounts',
  )
  expect(legacyAddress('#/s/AbCdEfGhIjKlMnOpQrStUv_-/collection/1')).toBe(
    '/s/AbCdEfGhIjKlMnOpQrStUv_-/collection/1',
  )
})

it('keeps a passkey link’s token in the fragment', () => {
  const token = 'a'.repeat(43)
  expect(legacyAddress(`#/passkey/${token}`)).toBe(`/passkey#${token}`)
})

it('leaves any other fragment alone, as Telegram’s launch data', () => {
  expect(legacyAddress('#tgWebAppData=user%3D1&tgWebAppVersion=8.0')).toBe(
    undefined,
  )
  expect(legacyAddress('')).toBeUndefined()
  expect(legacyAddress('#token')).toBeUndefined()
})
