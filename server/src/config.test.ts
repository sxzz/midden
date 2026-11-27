import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { loadConfig } from './config.ts'

const SECRET_KEY = 'k'.repeat(32)
const ACCOUNT = '9183b1c394e4cd2f0a7d3c978bc53a29'
const R2 = {
  MEDIA_STORE: 'r2',
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: 'midden',
  CF_API_TOKEN: 'very-secret-value',
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
        publicUrl: 'https://midden-media.sxzz.moe',
      },
    })
    expect(loadConfig({ SECRET_KEY, ...R2 }).cloudflare).toEqual({
      accountId: ACCOUNT,
      apiToken: 'very-secret-value',
    })
  })

  test('the zone to purge comes with the same token', () => {
    const zone = 'a'.repeat(32)
    expect(
      loadConfig({ SECRET_KEY, ...R2, CF_ZONE_ID: zone }).cloudflare,
    ).toEqual({
      accountId: ACCOUNT,
      apiToken: 'very-secret-value',
      zoneId: zone,
    })
  })

  test('r2 names what is missing', () => {
    const { CF_API_TOKEN: _, MEDIA_PUBLIC_URL: __, ...partial } = R2
    expect(() => loadConfig({ SECRET_KEY, ...partial })).toThrow(
      'MEDIA_STORE=r2 needs CF_API_TOKEN, MEDIA_PUBLIC_URL',
    )
  })

  test('r2 without CF_API_TOKEN does not start, old keys or not', () => {
    const { CF_API_TOKEN: _, ...partial } = R2
    expect(() =>
      loadConfig({
        SECRET_KEY,
        ...partial,
        R2_ACCESS_KEY_ID: 'old-id',
        R2_SECRET_ACCESS_KEY: 'old-secret',
        CF_PURGE_TOKEN: 'old-purge',
      }),
    ).toThrow('MEDIA_STORE=r2 needs CF_API_TOKEN')
  })

  test('the analytics need the account and the token, not R2', () => {
    expect(loadConfig({ SECRET_KEY }).cloudflare).toBeUndefined()
    expect(
      loadConfig({
        SECRET_KEY,
        R2_ACCOUNT_ID: ACCOUNT,
        CF_API_TOKEN: 'token',
      }).cloudflare,
    ).toEqual({ accountId: ACCOUNT, apiToken: 'token' })
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
    ['CF_API_TOKEN', '', 'CF_API_TOKEN is empty'],
  ])('rejects %s=%j', (name, value, message) => {
    expect(() => loadConfig({ SECRET_KEY, ...R2, [name]: value })).toThrow(
      message,
    )
  })

  test('errors never repeat a credential', () => {
    for (const env of [
      { ...R2, R2_ACCOUNT_ID: 'x' },
      { ...R2, CF_ZONE_ID: 'x' },
      { ...R2, MEDIA_PUBLIC_URL: undefined },
    ])
      expect(() => loadConfig({ SECRET_KEY, ...env })).toThrow(
        expect.objectContaining({
          message: expect.not.stringMatching(/very-secret-value/),
        }),
      )
  })
})

test('WEB_APP_URL is an https origin, kept with a trailing slash', () => {
  expect(
    loadConfig({ SECRET_KEY, WEB_APP_URL: 'https://midden.example' }).webAppUrl,
  ).toBe('https://midden.example/')
  expect(
    loadConfig({ SECRET_KEY, WEB_APP_URL: 'https://midden.example/' })
      .webAppUrl,
  ).toBe('https://midden.example/')
  for (const url of [
    'https://midden.example/app/',
    'http://midden.example/',
    'https://midden.example/?v=1',
  ])
    expect(() => loadConfig({ SECRET_KEY, WEB_APP_URL: url })).toThrow(
      /WEB_APP_URL/,
    )
})

test('the Litestream heartbeat watch follows its access key', () => {
  expect(loadConfig({ SECRET_KEY }).litestream).toBe(false)
  expect(
    loadConfig({ SECRET_KEY, LITESTREAM_ACCESS_KEY_ID: '' }).litestream,
  ).toBe(false)
  expect(
    loadConfig({ SECRET_KEY, LITESTREAM_ACCESS_KEY_ID: 'key' }).litestream,
  ).toBe(true)
})

test('the server exits before listening when r2 lacks CF_API_TOKEN', () => {
  // So /healthz never answers and the deploy rolls back (scripts/deploy.ts).
  const { CF_API_TOKEN: _, ...partial } = R2
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('main.ts', import.meta.url))],
    {
      env: {
        SECRET_KEY,
        ...partial,
        DATA_DIR: mkdtempSync(path.join(tmpdir(), 'midden-config-')),
        PORT: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('MEDIA_STORE=r2 needs CF_API_TOKEN')
  expect(result.stdout).not.toContain('listening')
})

describe('raw response bucket configuration', () => {
  const RAW = { R2_ACCOUNT_ID: ACCOUNT, RAW_R2_BUCKET: 'midden-backup' }
  const endpoint = `https://${ACCOUNT}.r2.cloudflarestorage.com`

  test('raw responses stay in the database without it', () => {
    expect(loadConfig({ SECRET_KEY }).raw).toBeUndefined()
    expect(loadConfig({ SECRET_KEY, ...R2 }).raw).toBeUndefined()
  })

  test("R2's keys from the API token, with media in R2 or not", () => {
    const raw = { endpoint, bucket: 'midden-backup' }
    expect(
      loadConfig({ SECRET_KEY, ...RAW, CF_API_TOKEN: 'token' }).raw,
    ).toEqual(raw)
    expect(loadConfig({ SECRET_KEY, ...R2, ...RAW })).toMatchObject({
      raw,
      media: { store: 'r2', r2: { bucket: 'midden' } },
    })
  })

  test('names what is missing', () => {
    expect(() => loadConfig({ SECRET_KEY, RAW_R2_BUCKET: 'b-raw' })).toThrow(
      'RAW_R2_BUCKET needs R2_ACCOUNT_ID, CF_API_TOKEN',
    )
    expect(() => loadConfig({ SECRET_KEY, ...RAW })).toThrow(
      'RAW_R2_BUCKET needs CF_API_TOKEN',
    )
    expect(() =>
      loadConfig({ SECRET_KEY, RAW_R2_BUCKET: 'b-raw', CF_API_TOKEN: 'token' }),
    ).toThrow('RAW_R2_BUCKET needs R2_ACCOUNT_ID')
  })

  test('never the public media bucket', () => {
    expect(() =>
      loadConfig({ SECRET_KEY, ...R2, ...RAW, RAW_R2_BUCKET: 'midden' }),
    ).toThrow('RAW_R2_BUCKET must not be the public media bucket R2_BUCKET')
  })

  test('errors never repeat the API token', () => {
    const CF_API_TOKEN = 'very-secret-token'
    for (const env of [
      { ...RAW, CF_API_TOKEN, R2_ACCOUNT_ID: undefined },
      { ...RAW, CF_API_TOKEN, RAW_R2_BUCKET: 'Bad_Bucket' },
      { ...R2, ...RAW, CF_API_TOKEN, RAW_R2_BUCKET: 'midden' },
    ])
      expect(() => loadConfig({ SECRET_KEY, ...env })).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(CF_API_TOKEN),
        }),
      )
  })
})
