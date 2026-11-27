import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { seal, unseal } from '#crypto.ts'
import { accountCredentials } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

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
    return seal(this.#key, `credential:${ref}`, plaintext)
  }

  unseal(ref: string, sealed: Uint8Array): Buffer {
    return unseal(this.#key, `credential:${ref}`, sealed)
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
