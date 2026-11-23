import { vi } from 'vitest'
import { APIError, type Asset, type Collection, type Entity } from '../api'

const API_BASE = /^\/v1/

export interface Request {
  method: string
  /** The JSON body as sent, when there is one. */
  body?: string
  signal?: AbortSignal
}

/**
 * Answer the API client's requests with `handler`, called with the path below
 * `/v1` (query included). What it returns is the JSON body; `undefined` is a
 * 204, and a thrown APIError becomes that status with its message.
 */
export function mockApi(
  handler: (path: string, request: Request) => unknown = () => undefined,
) {
  const api = vi.fn(handler)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const path = url.pathname.replace(API_BASE, '') + url.search
      try {
        const body = await api(path, {
          method: init.method ?? 'GET',
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        })
        return body === undefined
          ? new Response(null, { status: 204 })
          : Response.json(body)
      } catch (error) {
        if (!(error instanceof APIError)) throw error
        return Response.json({ error: error.message }, { status: error.status })
      }
    }),
  )
  return api
}

export const asset = (fields: Partial<Asset> & { id: string }): Asset => ({
  position: 0,
  state: 'ready',
  sensitive: false,
  size: 0,
  ...fields,
})

export const entity = (
  fields: Partial<Entity> & { key: string; type: string },
): Entity => ({ external_id: fields.key, data: {}, ...fields })

export const collection = (fields: Partial<Collection>): Collection => ({
  id: 'collection',
  url: 'https://example.com/collection',
  external_id: 'collection',
  provider_id: 'x',
  revision_id: 'revision',
  text: '',
  text_kind: 'plain',
  adapter_version: '1',
  warnings: [],
  assets: [],
  observed_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  ...fields,
})
