import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { FetchResponse, type Provider } from '#platforms/protocol.ts'
import { validateGraph } from './graph.ts'
import { canonicalJson } from './json.ts'
import { overlayMetrics, splitMetrics } from './metrics.ts'

describe('canonicalJson', () => {
  test('sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    )
  })
})

describe('metrics', () => {
  const data = { likes: 3, metadata: { followers: 7, name: 'n' }, 'a/b': 1 }

  test('split removes declared values and leaves the rest', () => {
    const { data: rest, metrics } = splitMetrics(data, [
      '/likes',
      '/metadata/followers',
      '/a~1b',
      '/missing',
    ])
    expect(rest).toEqual({ metadata: { name: 'n' } })
    expect(metrics).toEqual({
      '/likes': 3,
      '/metadata/followers': 7,
      '/a~1b': 1,
    })
    expect(data.likes).toBe(3)
  })

  test('overlay restores values, creating parents but never replacing', () => {
    expect(
      overlayMetrics(
        { name: 'n', scalar: 1 },
        { '/metadata/followers': 7, '/scalar/x': 2 },
      ),
    ).toEqual({ name: 'n', scalar: 1, metadata: { followers: 7 } })
  })
})

describe('validateGraph', () => {
  const provider: Provider = {
    id: 'p',
    authentication: 'none',
    visibilities: [],
    capabilities: [{ name: 'entity.graph', major: 1, minor: 0 }],
    entityTypes: ['x.post', 'x.profile'],
    defaultProvider: true,
    credentialHelp: '',
  }
  const types = [
    { name: 'x.post', jsonSchema: Buffer.alloc(0), metricPaths: ['/likes'] },
    { name: 'x.profile', jsonSchema: Buffer.alloc(0), metricPaths: [] },
  ]
  const entity = (
    key: string,
    type: string,
    externalId: string,
    data: unknown = {},
    extra = {},
  ) => ({
    key,
    type,
    externalId,
    dataJson: Buffer.from(JSON.stringify(data)),
    resourceIndices: [],
    contextOnly: false,
    ...extra,
  })
  const response = (graph: object, extra = {}) =>
    FetchResponse.fromPartial({
      externalId: '1',
      resources: [{ url: 'https://m.test/a.jpg', kind: 'image' }],
      graph,
      ...extra,
    })

  test('normalizes order and splits metrics', () => {
    const result = validateGraph(
      response({
        root: 'post',
        entities: [
          entity(
            'post',
            'x.post',
            '1',
            { text: 't', likes: 5 },
            {
              resourceIndices: [0],
            },
          ),
          entity('author', 'x.profile', '9', {}, { contextOnly: true }),
        ],
        relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
      }),
      provider,
      types,
    )!
    expect(result.graph.entities.map((e) => e.key)).toEqual(['author', 'post'])
    expect(result.graph.entities[1]).toEqual({
      key: 'post',
      type: 'x.post',
      external_id: '1',
      data: { text: 't' },
      resource_indices: [0],
    })
    expect(result.metrics).toEqual({ 'x.post/1': { '/likes': 5 } })
    expect(result.metricPaths).toEqual({ 'x.post': ['/likes'] })
  })

  test.each([
    [
      { root: 'post', entities: [], relations: [] },
      'invalid entity graph size',
    ],
    [
      { root: 'post', entities: [entity('post', 'other', '1')], relations: [] },
      'invalid entity identity or undeclared type',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1', {}, { contextOnly: true })],
        relations: [],
      },
      'invalid entity identity or undeclared type',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '2')],
        relations: [],
      },
      'entity root does not match capture identity',
    ],
    [
      {
        root: 'nope',
        entities: [entity('post', 'x.post', '1')],
        relations: [],
      },
      'missing entity root',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1', {}, { resourceIndices: [1] })],
        relations: [],
      },
      'invalid entity resource reference',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1')],
        relations: [{ source: 'post', target: 'gone', type: 'quoted' }],
      },
      'invalid entity relation',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1')],
        relations: [
          { source: 'post', target: 'post', type: 'quoted' },
          { source: 'post', target: 'post', type: 'quoted' },
        ],
      },
      'duplicate entity relation',
    ],
  ])('rejects %#', (graph, message) => {
    expect(() => validateGraph(response(graph), provider, types)).toThrow(
      message,
    )
  })

  test('the root follows the canonical target', () => {
    expect(
      validateGraph(
        response(
          {
            root: 'author',
            entities: [entity('author', 'x.profile', '42')],
            relations: [],
          },
          { externalId: 'handle:x', canonicalTarget: { externalId: '42' } },
        ),
        provider,
        types,
      )?.graph.root,
    ).toBe('author')
  })
})
