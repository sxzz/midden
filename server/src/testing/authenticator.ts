import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest()
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url')

// User present and user verified; AT marks attested credential data.
const UP_UV = 0x05
const AT = 0x40

/**
 * A software authenticator holding one ES256 passkey: it answers the
 * server's options the way a browser and a platform authenticator would.
 */
export function softAuthenticator(options: { userVerified?: boolean } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(16)
  const id = b64(credentialId)
  let counter = 0
  let rpId = ''
  const flags = options.userVerified === false ? 0x01 : UP_UV

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const header = (rp: string, extra: number) => {
    const counterBytes = Buffer.alloc(4)
    counterBytes.writeUInt32BE(counter)
    return Buffer.concat([
      sha256(rp),
      Buffer.from([flags | extra]),
      counterBytes,
    ])
  }

  return {
    id,
    get counter() {
      return counter
    },
    set counter(value: number) {
      counter = value
    },
    create(
      creation: PublicKeyCredentialCreationOptionsJSON,
      origin: string,
    ): RegistrationResponseJSON {
      rpId = creation.rp.id!
      const cose = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ])
      const length = Buffer.alloc(2)
      length.writeUInt16BE(credentialId.length)
      const authData = Buffer.concat([
        header(rpId, AT),
        Buffer.alloc(16),
        length,
        credentialId,
        isoCBOR.encode(cose),
      ])
      const attestation = isoCBOR.encode(
        new Map<string, string | Map<string, string> | Uint8Array>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, string>()],
          ['authData', authData],
        ]),
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(
            clientData('webauthn.create', creation.challenge, origin),
          ),
          attestationObject: b64(attestation),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      }
    },
    /** Sign in; `rp` overrides the RP ID the passkey was made for. */
    get(
      request: PublicKeyCredentialRequestOptionsJSON,
      origin: string,
      rp = rpId,
    ): AuthenticationResponseJSON {
      counter++
      const authData = header(rp, 0)
      const json = clientData('webauthn.get', request.challenge, origin)
      const signature = sign(
        'sha256',
        Buffer.concat([authData, sha256(json)]),
        privateKey,
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(json),
          authenticatorData: b64(authData),
          signature: b64(signature),
          userHandle: b64(new TextEncoder().encode('midden-owner')),
        },
        clientExtensionResults: {},
      }
    },
  }
}
