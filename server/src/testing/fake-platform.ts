import { Buffer } from 'node:buffer'
import {
  FetchResponse,
  Visibility,
  type FetchRequest,
} from '#platforms/protocol.ts'
import { Metadata, status } from '#platforms/rpc.ts'
import type { Platform, ProviderFailure } from '#platforms/platform.ts'

const POST = /^\/p\/(\w+)$/
const PROFILE = /^\/u\/(\w+)$/
const NUMERIC = /^\d+$/

const capabilities = (...names: string[]) =>
  names.map((name) => ({ name, major: 1, minor: 0 }))

export class FakeFailure extends Error implements ProviderFailure {
  code: status
  metadata = new Metadata()
  constructor(
    code: status,
    message: string,
    trailers: Record<string, string> = {},
  ) {
    super(message)
    this.code = code
    for (const [key, value] of Object.entries(trailers))
      this.metadata.set(key, value)
  }
}

export type FakeFetch = (
  req: FetchRequest,
) => Partial<FetchResponse> | Promise<Partial<FetchResponse>>

/**
 * A platform at `fake.test`: `/p/<id>` is a post, `/u/<handle>` a profile
 * (a collection). Tests decide what each fetch returns.
 */
export function fakePlatform(fetch: { current: FakeFetch }): Platform {
  const shared = [
    'capture.fetch',
    'capture.related',
    'capture.page',
    'capture.canonical',
    'capture.prefetch',
    'entity.graph',
  ]
  const types = ['fake.post', 'fake.profile']
  return {
    description: {
      protocolVersion: '1.0',
      adapterId: 'fake',
      displayName: 'Fake',
      version: '1',
      hosts: ['fake.test'],
      entityTypes: [
        {
          name: 'fake.post',
          jsonSchema: Buffer.alloc(0),
          metricPaths: ['/likes'],
          volatilePaths: ['/facets'],
        },
        {
          name: 'fake.profile',
          jsonSchema: Buffer.alloc(0),
          metricPaths: [],
          volatilePaths: [],
        },
      ],
      providers: [
        {
          id: 'public',
          authentication: 'none',
          defaultProvider: true,
          credentialHelp: '',
          entityTypes: types,
          capabilities: capabilities(...shared),
          visibilities: [Visibility.VISIBILITY_PUBLIC],
        },
        {
          id: 'session',
          authentication: 'session',
          defaultProvider: true,
          credentialHelp: '',
          entityTypes: types,
          capabilities: capabilities(
            ...shared,
            'credential.deferred',
            'credential.prepare',
            'connection.check',
          ),
          visibilities: [Visibility.VISIBILITY_PUBLIC],
        },
      ],
    },
    resolve(raw) {
      const url = new URL(raw)
      const post = POST.exec(url.pathname)
      if (post)
        return {
          url: `https://fake.test/p/${post[1]}`,
          platform: 'fake',
          kind: 'post',
          objectScope: '',
          externalId: post[1]!,
          collection: false,
          refreshOnSubmit: false,
        }
      const profile = PROFILE.exec(url.pathname)
      if (profile)
        return {
          url: `https://fake.test/u/${profile[1]}`,
          platform: 'fake',
          kind: 'profile',
          objectScope: '',
          externalId: NUMERIC.test(profile[1]!)
            ? profile[1]!
            : `handle:${profile[1]}`,
          collection: true,
          refreshOnSubmit: true,
        }
      throw new FakeFailure(status.INVALID_ARGUMENT, 'unsupported link')
    },
    async fetch(req) {
      const partial = await fetch.current(req)
      return FetchResponse.fromPartial({
        externalId: req.externalId,
        providerId: req.providerId,
        adapterVersion: '1',
        textKind: 'plain',
        ...(partial as object),
      })
    },
    prepareCredential: (_provider, input) => ({ data: Buffer.from(input) }),
    checkConnection: (_provider, credential) =>
      Promise.resolve({
        accountId: Buffer.from(credential?.data ?? []).toString(),
        username: 'fake',
      }),
  }
}

/** A post graph with a context author. */
export function postGraph(
  id: string,
  post: Record<string, unknown>,
  author?: Record<string, unknown>,
  extra: { resourceIndices?: number[]; authorResources?: number[] } = {},
) {
  return {
    root: 'post',
    entities: [
      {
        key: 'post',
        type: 'fake.post',
        externalId: id,
        dataJson: Buffer.from(JSON.stringify(post)),
        resourceIndices: extra.resourceIndices ?? [],
        contextOnly: false,
      },
      {
        key: 'author',
        type: 'fake.profile',
        externalId: '7',
        dataJson: Buffer.from(JSON.stringify(author ?? { name: 'Author' })),
        resourceIndices: extra.authorResources ?? [],
        contextOnly: true,
      },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  }
}
