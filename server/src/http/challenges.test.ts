import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { CHALLENGE_TTL, Challenges, type ChallengeScope } from './challenges.ts'

const LOGIN: ChallengeScope = { purpose: 'login', origin: 'https://a.test' }
const REGISTER: ChallengeScope = {
  purpose: 'register',
  origin: 'https://a.test',
  binding: 'link:1',
}
const NOW = 1_800_000_000_000
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

test('a challenge answers once, for its own scope, until it expires', () => {
  const challenges = new Challenges(randomBytes(32))
  const login = b64(challenges.issue(LOGIN, NOW))
  // Wrong purpose, wrong origin.
  expect(challenges.take(login, { ...REGISTER, binding: undefined }, NOW)).toBe(
    false,
  )
  expect(
    challenges.take(login, { ...LOGIN, origin: 'https://b.test' }, NOW),
  ).toBe(false)
  expect(challenges.take(login, LOGIN, NOW)).toBe(true)
  // Reused.
  expect(challenges.take(login, LOGIN, NOW + 1)).toBe(false)

  const register = b64(challenges.issue(REGISTER, NOW))
  // Another link, or signed in instead.
  expect(
    challenges.take(register, { ...REGISTER, binding: 'link:2' }, NOW),
  ).toBe(false)
  expect(
    challenges.take(register, { ...REGISTER, binding: 'caller:1' }, NOW),
  ).toBe(false)
  // Expired.
  expect(challenges.take(register, REGISTER, NOW + CHALLENGE_TTL)).toBe(false)
  expect(challenges.take(register, REGISTER, NOW + CHALLENGE_TTL - 1)).toBe(
    true,
  )
})

test('a tampered challenge or one signed with another key is refused', () => {
  const challenges = new Challenges(randomBytes(32))
  const raw = challenges.issue(LOGIN, NOW)
  // Nonce, expiry and MAC bytes.
  for (const at of [0, 15, 16, 23, 24, 55]) {
    const copy = new Uint8Array(raw)
    copy[at]! ^= 1
    expect(challenges.take(b64(copy), LOGIN, NOW)).toBe(false)
  }
  expect(challenges.take(b64(raw.subarray(0, 40)), LOGIN, NOW)).toBe(false)
  expect(challenges.take('', LOGIN, NOW)).toBe(false)
  expect(new Challenges(randomBytes(32)).take(b64(raw), LOGIN, NOW)).toBe(false)
  expect(challenges.take(b64(raw), LOGIN, NOW)).toBe(true)
})
