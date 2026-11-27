import { afterEach, expect, it, vi } from 'vitest'

const BODY = {
  url: '/media/aa/bb/x?e=1',
  thumbnail_url: 'https://cdn.test/x',
  remote_url: '//elsewhere.test/x',
  items: [
    { download_url: '/media/aa/bb/y?n=y.jpg', note: '/media/not-a-link' },
  ],
}

async function load(apiUrl: string | undefined) {
  vi.resetModules()
  if (apiUrl !== undefined) vi.stubEnv('VITE_API_URL', apiUrl)
  const fetch = vi.fn(async () => Response.json(BODY))
  vi.stubGlobal('fetch', fetch)
  const api = await import('./api')
  const body = await api.call(api.client.instance.$get())
  return { api, body, fetch }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('calls the API on its own origin with the cookie, and its links point there', async () => {
  const { api, body, fetch } = await load('https://api.test/')
  const [input, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(input)).toBe('https://api.test/v1/instance')
  expect(init.credentials).toBe('include')
  expect(api.apiAddress()).toBe('https://api.test')
  // The server's own links, and only those, get the API's origin.
  expect(body).toEqual({
    url: 'https://api.test/media/aa/bb/x?e=1',
    thumbnail_url: 'https://cdn.test/x',
    remote_url: '//elsewhere.test/x',
    items: [
      {
        download_url: 'https://api.test/media/aa/bb/y?n=y.jpg',
        note: '/media/not-a-link',
      },
    ],
  })
})

it('calls the page’s own origin when no API address is built in', async () => {
  const { api, body, fetch } = await load(undefined)
  const [input, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(input)).toBe('/v1/instance')
  expect(init.credentials).toBe('same-origin')
  expect(api.apiAddress()).toBe(location.origin)
  expect(body).toEqual(BODY)
})
