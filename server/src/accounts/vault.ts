import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { accountCredentials } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

const NONCE = 12
const TAG = 16

/**
 * Credentials encrypted at rest with AES-256-GCM. Each one is bound to its
 * row id, so a ciphertext copied to another row does not decrypt.
 */
export class Vault {
  readonly #key: Buffer

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('vault key must be 32 bytes')
    this.#key = Buffer.from(key)
  }

  seal(ref: string, plaintext: Uint8Array): Buffer {
    const nonce = randomBytes(NONCE)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce)
    cipher.setAAD(Buffer.from(`credential:${ref}`))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([nonce, body, cipher.getAuthTag()])
  }

  unseal(ref: string, sealed: Uint8Array): Buffer {
    const data = Buffer.from(sealed)
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      data.subarray(0, NONCE),
    )
    decipher.setAAD(Buffer.from(`credential:${ref}`))
    decipher.setAuthTag(data.subarray(data.length - TAG))
    return Buffer.concat([
      decipher.update(data.subarray(NONCE, data.length - TAG)),
      decipher.final(),
    ])
  }

  open(db: Executor, ref: string): Buffer {
    const row = db
      .select()
      .from(accountCredentials)
      .where(eq(accountCredentials.id, ref))
      .get()
    if (!row) throw new Error('credential not found')
    return this.unseal(ref, row.ciphertext)
  }
}
