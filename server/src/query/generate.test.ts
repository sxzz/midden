import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { GENERATED, generateParser } from './generate.ts'

test('the committed parser is what the grammar gives (pnpm gen:query)', () => {
  expect(readFileSync(GENERATED, 'utf8')).toBe(generateParser())
})
