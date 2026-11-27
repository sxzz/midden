import { Buffer } from 'node:buffer'
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

/**
 * Derive an independent key per purpose, so a leak or misuse in one place
 * (for example a signed media URL) reveals nothing about another.
 */
export function deriveKey(
  secret: string,
  purpose: string,
  length = 32,
): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, '', `midden:${purpose}`, length),
  )
}

const NONCE = 12
const TAG = 16

/**
 * AES-256-GCM with a fresh nonce: nonce, ciphertext and tag in one buffer.
 * `aad` binds it to where it is kept (a row's id), so a ciphertext copied
 * elsewhere does not open.
 */
export function seal(
  key: Uint8Array,
  aad: string,
  plaintext: Uint8Array,
): Buffer {
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

/** What `seal` sealed with the same key and `aad`; throws otherwise. */
export function unseal(
  key: Uint8Array,
  aad: string,
  sealed: Uint8Array,
): Buffer {
  const data = Buffer.from(sealed)
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, NONCE))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(data.subarray(data.length - TAG))
  return Buffer.concat([
    decipher.update(data.subarray(NONCE, data.length - TAG)),
    decipher.final(),
  ])
}
