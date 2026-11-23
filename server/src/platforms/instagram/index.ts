import { guard, type Platform } from '../platform.ts'
import { Visibility, type FetchRequest } from '../protocol.ts'
import { status } from '../rpc.ts'
import { InstagramClient } from './client.ts'
import { decodeCredential, prepareCredential } from './credential.ts'
import { entityTypes, version } from './entities.ts'
import { ProviderError } from './errors.ts'
import { hosts, resolveTarget } from './resolve.ts'
import { CaptureStrategy } from './strategy.ts'

const PROVIDER = 'instagram-session'
const failure = (code: status, message: string) =>
  new ProviderError(code, message)
const NUMERIC = /^\d+$/

export function createInstagramPlatform(
  strategy = new CaptureStrategy(),
  fetcher: typeof fetch = fetch,
): Platform {
  function validate(req: FetchRequest) {
    const target = resolveTarget(req.url)
    if (
      // A profile may be addressed by its stable numeric ID once known.
      (target.externalId !== req.externalId &&
        (target.kind !== 'profile' || !NUMERIC.test(req.externalId))) ||
      target.platform !== req.platform ||
      target.kind !== req.kind ||
      target.objectScope !== req.objectScope
    )
      throw new ProviderError(
        status.INVALID_ARGUMENT,
        'invalid target identity',
      )
    if (
      req.providerId !== PROVIDER ||
      !req.connectionId ||
      req.accessScope !== `connection:${req.connectionId}`
    )
      throw new ProviderError(
        status.INVALID_ARGUMENT,
        'invalid provider or connection',
      )
  }
  return {
    description: {
      protocolVersion: '1.0',
      adapterId: 'instagram',
      displayName: 'Instagram',
      version,
      hosts,
      entityTypes,
      providers: [
        {
          id: PROVIDER,
          defaultProvider: true,
          credentialHelp:
            'Base64 浏览器 Cookie，需包含 sessionid；保留 csrftoken、ds_user_id、mid 和 ig_did。',
          authentication: 'session',
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: [
            'capture.fetch',
            'capture.related',
            'capture.page',
            'capture.canonical',
            'connection.check',
            'credential.prepare',
            'credential.deferred',
            'content.text',
            'entity.graph',
            'source.raw',
            'media.image',
            'media.video',
          ].map((name) => ({ name, major: 1, minor: 0 })),
          visibilities: [Visibility.VISIBILITY_PRIVATE],
        },
      ],
    },
    resolve: resolveTarget,
    prepareCredential(providerId, input) {
      if (providerId !== PROVIDER)
        throw new ProviderError(
          status.UNIMPLEMENTED,
          'credential import unsupported',
        )
      return prepareCredential(input)
    },
    fetch: (req, signal) =>
      guard(signal, failure, (signal) => {
        validate(req)
        return strategy.fetch(
          req,
          signal,
          req.credentialDeferred && !req.credential
            ? undefined
            : decodeCredential(req.credential),
        )
      }),
    checkConnection: (providerId, credential, signal) =>
      guard(signal, failure, (signal) => {
        if (providerId !== PROVIDER)
          throw new ProviderError(
            status.INVALID_ARGUMENT,
            'unsupported account provider',
          )
        return new InstagramClient(
          signal,
          decodeCredential(credential),
          fetcher,
        ).checkConnection()
      }),
  }
}
