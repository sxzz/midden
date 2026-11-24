import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { FetchResponse, type Provider } from '#platforms/protocol.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import { normalizeProfile } from '#platforms/x/profile.ts'
import { ignoredPaths, revisionDigest } from './finalize.ts'
import { validateGraph } from './graph.ts'
import { canonicalJson } from './json.ts'
import { overlayMetrics, splitMetrics } from './metrics.ts'
import type { Payload } from './payload.ts'

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
    {
      name: 'x.post',
      jsonSchema: Buffer.alloc(0),
      metricPaths: ['/likes'],
      volatilePaths: [],
    },
    {
      name: 'x.profile',
      jsonSchema: Buffer.alloc(0),
      metricPaths: [],
      volatilePaths: [],
    },
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
    [{ root: 'post', entities: [], relations: [] }, '实体图大小无效'],
    [
      { root: 'post', entities: [entity('post', 'other', '1')], relations: [] },
      '实体标识无效或类型未声明',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1', {}, { contextOnly: true })],
        relations: [],
      },
      '实体标识无效或类型未声明',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '2')],
        relations: [],
      },
      '实体根与采集对象不符',
    ],
    [
      {
        root: 'nope',
        entities: [entity('post', 'x.post', '1')],
        relations: [],
      },
      '缺少实体根',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1', {}, { resourceIndices: [1] })],
        relations: [],
      },
      '实体引用的媒体无效',
    ],
    [
      {
        root: 'post',
        entities: [entity('post', 'x.post', '1')],
        relations: [{ source: 'post', target: 'gone', type: 'quoted' }],
      },
      '实体关系无效',
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
      '实体关系重复',
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

describe('revision digest of an X profile', () => {
  const platforms = new Platforms([createXPlatform()])
  const x = platforms.byId('x').description
  const provider = x.providers.find((p) => p.id === 'fxtwitter')!
  const user = {
    type: 'profile',
    id: '123',
    name: 'Name',
    screen_name: 'name',
    protected: false,
    description: 'Bio @friend',
    raw_description: { text: 'Bio @friend', facets: [] as object[] },
    followers: 1,
    about_account: { based_in: 'Japan' } as object | undefined,
  }
  function digest(profile: Partial<typeof user>): string {
    const response = normalizeProfile(
      { ...user, ...profile },
      '123',
      'fxtwitter',
    )
    const { graph, metricPaths } = validateGraph(
      response,
      provider,
      x.entityTypes,
    )!
    const payload: Payload = {
      text: response.text,
      text_kind: response.textKind,
      warnings: [],
      adapter_version: response.adapterVersion,
      graph,
      metric_paths: metricPaths,
    }
    const context = new Set(
      graph.entities
        .filter((e) => e.context_only)
        .map((e) => `${e.type}/${e.external_id}`),
    )
    return revisionDigest(
      payload,
      [],
      context,
      ignoredPaths(platforms, 'x', metricPaths),
    )
  }

  test('mention facets and about_account that come and go count for nothing', () => {
    const base = digest({})
    // Seen on consecutive requests for the same bio.
    const facet = { type: 'mention', indices: [4, 11], original: 'friend' }
    expect(
      digest({ raw_description: { text: user.description, facets: [facet] } }),
    ).toBe(base)
    expect(digest({ about_account: undefined })).toBe(base)
    expect(digest({ followers: 2 })).toBe(base)
    expect(
      digest({
        description: 'Other',
        raw_description: { text: 'Other', facets: [] },
      }),
    ).not.toBe(base)
  })
})
