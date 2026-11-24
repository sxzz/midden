import { expect, test } from 'vitest'
import { loadConfig } from './config.ts'

const base = { SECRET_KEY: 'x'.repeat(32) }

test('web origins start with the Mini App URL and add WEB_ORIGINS', () => {
  expect(loadConfig(base).webOrigins).toEqual([])
  expect(
    loadConfig({ ...base, WEB_APP_URL: 'https://a.test/app/' }).webOrigins,
  ).toEqual(['https://a.test'])
  expect(
    loadConfig({
      ...base,
      WEB_APP_URL: 'https://a.test/app/',
      WEB_ORIGINS: 'https://b.test/, https://a.test,http://localhost:5173',
    }).webOrigins,
  ).toEqual(['https://a.test', 'https://b.test', 'http://localhost:5173'])
  for (const bad of ['http://b.test', 'https://b.test/app/', 'b.test'])
    expect(() => loadConfig({ ...base, WEB_ORIGINS: bad })).toThrow(
      'WEB_ORIGINS',
    )
})
