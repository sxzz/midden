import { guard, type Platform } from '../platform.ts'
import { Visibility, type FetchRequest } from '../protocol.ts'
import { status } from '../rpc.ts'
import { decodeCredential, prepareCredential } from './credential.ts'
import { entityTypes } from './entity-schemas.ts'
import { ProviderError } from './provider.ts'
import { hosts, resolveTarget } from './resolve.ts'
import { checkSession } from './session.ts'
import { CaptureStrategy } from './strategy.ts'

const capabilities = (names: string[]) =>
  names.map((name) => ({ name, major: 1, minor: 0 }))
const shared = [
  'capture.fetch',
  'capture.related',
  'capture.page',
  'capture.canonical',
  'capture.prefetch',
  'content.text',
  'entity.graph',
  'source.raw',
  'media.image',
  'media.video',
]
const failure = (code: status, message: string) =>
  new ProviderError(code, message)

export function createXPlatform(
  strategy = new CaptureStrategy(),
  connectionCheck = checkSession,
): Platform {
  function validate(req: FetchRequest) {
    const target = resolveTarget(req.url)
    if (
      target.externalId !== req.externalId ||
      target.platform !== req.platform ||
      target.kind !== req.kind ||
      target.objectScope !== req.objectScope
    )
      throw new ProviderError(
        status.INVALID_ARGUMENT,
        'invalid target identity',
      )
  }
  return {
    description: {
      protocolVersion: '1.0',
      adapterId: 'x',
      displayName: 'X',
      version: '0.4.0',
      hosts,
      entityTypes,
      providers: [
        {
          id: 'fxtwitter',
          defaultProvider: true,
          credentialHelp: '',
          authentication: 'none',
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: capabilities(shared),
          visibilities: [Visibility.VISIBILITY_PUBLIC],
        },
        {
          id: 'x-session',
          defaultProvider: true,
          credentialHelp: 'Base64 Cookie，需包含 auth_token 和 ct0。',
          authentication: 'session',
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: capabilities([
            ...shared,
            'connection.check',
            'credential.prepare',
            'credential.deferred',
          ]),
          visibilities: [
            Visibility.VISIBILITY_PUBLIC,
            Visibility.VISIBILITY_PRIVATE,
          ],
        },
      ],
    },
    resolve: resolveTarget,
    prepareCredential(providerId, input) {
      if (providerId !== 'x-session')
        throw new ProviderError(
          status.UNIMPLEMENTED,
          'credential import unsupported',
        )
      return prepareCredential(input)
    },
    fetch: (req, signal) =>
      guard(signal, failure, (signal) => {
        validate(req)
        if (
          req.providerId === 'fxtwitter' &&
          !req.connectionId &&
          req.accessScope === 'public' &&
          !req.credential
        )
          return strategy.fetch(req, signal)
        if (
          req.providerId !== 'x-session' ||
          !req.connectionId ||
          req.accessScope !== `connection:${req.connectionId}`
        )
          throw new ProviderError(
            status.INVALID_ARGUMENT,
            'invalid provider or connection',
          )
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
        if (providerId !== 'x-session')
          throw new ProviderError(
            status.INVALID_ARGUMENT,
            'unsupported account provider',
          )
        return connectionCheck(decodeCredential(credential), signal)
      }),
  }
}
