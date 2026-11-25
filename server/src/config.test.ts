import { describe, expect, test } from 'vitest'
import { loadConfig } from './config.ts'

const SECRET_KEY = 'k'.repeat(32)
const ACCOUNT = '9183b1c394e4cd2f0a7d3c978bc53a29'
const R2 = {
  MEDIA_STORE: 'r2',
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: 'midden',
  R2_ACCESS_KEY_ID: 'access-key-id',
  R2_SECRET_ACCESS_KEY: 'very-secret-value',
  MEDIA_PUBLIC_URL: 'https://midden-media.sxzz.moe/',
}

describe('media store configuration', () => {
  test('local by default, whatever else is set', () => {
    expect(loadConfig({ SECRET_KEY }).media).toEqual({ store: 'local' })
    expect(
      loadConfig({ SECRET_KEY, ...R2, MEDIA_STORE: 'local' }).media,
    ).toEqual({ store: 'local' })
  })

  test('r2 with every setting', () => {
    expect(loadConfig({ SECRET_KEY, ...R2 }).media).toEqual({
      store: 'r2',
      r2: {
        endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
        bucket: 'midden',
        accessKeyId: 'access-key-id',
        secretAccessKey: 'very-secret-value',
        publicUrl: 'https://midden-media.sxzz.moe',
      },
    })
  })

  test('purging needs both the zone and the token', () => {
    const zone = 'a'.repeat(32)
    expect(
      loadConfig({ SECRET_KEY, ...R2, CF_ZONE_ID: zone, CF_PURGE_TOKEN: 't' })
        .media,
    ).toMatchObject({ r2: { purge: { zoneId: zone, token: 't' } } })
    expect(() => loadConfig({ SECRET_KEY, ...R2, CF_ZONE_ID: zone })).toThrow(
      'CF_ZONE_ID and CF_PURGE_TOKEN are set together',
    )
  })

  test('r2 names what is missing', () => {
    const { R2_SECRET_ACCESS_KEY: _, MEDIA_PUBLIC_URL: __, ...partial } = R2
    expect(() => loadConfig({ SECRET_KEY, ...partial })).toThrow(
      'MEDIA_STORE=r2 needs R2_SECRET_ACCESS_KEY, MEDIA_PUBLIC_URL',
    )
  })

  test.each([
    ['MEDIA_STORE', 's3', 'MEDIA_STORE must be local or r2'],
    ['R2_ACCOUNT_ID', 'not-an-account', 'R2_ACCOUNT_ID must be 32 hex digits'],
    ['R2_BUCKET', 'Bad_Bucket', 'R2_BUCKET must be a bucket name'],
    [
      'MEDIA_PUBLIC_URL',
      'http://midden-media.sxzz.moe',
      'MEDIA_PUBLIC_URL must be an https URL without query',
    ],
    [
      'MEDIA_PUBLIC_URL',
      'https://midden-media.sxzz.moe/?a=1',
      'MEDIA_PUBLIC_URL must be an https URL without query',
    ],
    ['CF_ZONE_ID', 'zone', 'CF_ZONE_ID must be 32 hex digits'],
    ['R2_SECRET_ACCESS_KEY', '', 'R2_SECRET_ACCESS_KEY is empty'],
  ])('rejects %s=%j', (name, value, message) => {
    expect(() => loadConfig({ SECRET_KEY, ...R2, [name]: value })).toThrow(
      message,
    )
  })

  test('errors never repeat a credential', () => {
    for (const env of [
      { ...R2, R2_ACCOUNT_ID: 'x' },
      { ...R2, CF_ZONE_ID: 'x', CF_PURGE_TOKEN: 'secret-purge-token' },
      { ...R2, MEDIA_PUBLIC_URL: undefined },
    ])
      expect(() => loadConfig({ SECRET_KEY, ...env })).toThrow(
        expect.objectContaining({
          message: expect.not.stringMatching(
            /very-secret-value|secret-purge-token|access-key-id/,
          ),
        }),
      )
  })
})
