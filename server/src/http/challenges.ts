import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const CHALLENGE_TTL = 5 * 60 * 1000

const NONCE = 16
const EXPIRY = 8
const MAC = 32
const LENGTH = NONCE + EXPIRY + MAC

/** What a challenge is good for; answering it anywhere else fails. */
export interface ChallengeScope {
  purpose: 'login' | 'register'
  origin: string
  /** For registration: the /passkey link or the signed-in caller. */
  binding?: string
}

/**
 * WebAuthn challenges that carry their own proof: a random nonce, an expiry
 * and a MAC over both and the scope. Nothing is stored until one is
 * answered; then its nonce is remembered until it expires, so it answers
 * once. That memory lives in this process only.
 */
export class Challenges {
  readonly #key: Buffer
  readonly #used = new Map<string, number>()

  constructor(key: Buffer) {
    this.#key = key
  }

  #mac(scope: ChallengeScope, nonce: Buffer, expiry: Buffer): Buffer {
    return createHmac('sha256', this.#key)
      .update(
        JSON.stringify([
          scope.purpose,
          scope.origin,
          scope.binding ?? '',
          nonce.toString('base64url'),
          expiry.toString('hex'),
        ]),
      )
      .digest()
  }

  issue(scope: ChallengeScope, now: number): Uint8Array<ArrayBuffer> {
    const nonce = randomBytes(NONCE)
    const expiry = Buffer.alloc(EXPIRY)
    expiry.writeBigUInt64BE(BigInt(now + CHALLENGE_TTL))
    const out = new Uint8Array(LENGTH)
    out.set(nonce, 0)
    out.set(expiry, NONCE)
    out.set(this.#mac(scope, nonce, expiry), NONCE + EXPIRY)
    return out
  }

  /**
   * Use up a challenge (base64url, as the client echoes it) if it was issued
   * for this scope and has not expired or been answered before.
   */
  take(challenge: string, scope: ChallengeScope, now: number): boolean {
    const raw = Buffer.from(challenge, 'base64url')
    if (raw.length !== LENGTH) return false
    const nonce = raw.subarray(0, NONCE)
    const expiry = raw.subarray(NONCE, NONCE + EXPIRY)
    if (
      !timingSafeEqual(
        raw.subarray(NONCE + EXPIRY),
        this.#mac(scope, nonce, expiry),
      )
    )
      return false
    const expiresAt = Number(expiry.readBigUInt64BE())
    if (expiresAt <= now) return false
    for (const [key, until] of this.#used)
      if (until <= now) this.#used.delete(key)
    const key = nonce.toString('base64url')
    if (this.#used.has(key)) return false
    this.#used.set(key, expiresAt)
    return true
  }
}
