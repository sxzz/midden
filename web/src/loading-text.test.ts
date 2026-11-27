import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'

// The app shows what is loading as a skeleton of its layout, and keeps what
// it showed while it reads again (useStale, SkeletonRows): a line of
// 「加载中」 in its place makes the page jump twice and flicker on every poll.
const WORDS = ['加载中']
/** Files that may say it anyway, each with why. */
const ALLOWED: Record<string, string> = {
  'loading-text.test.ts': 'this guard names the words it looks for',
}

// Tests run from the web package (its vitest config).
const root = join(process.cwd(), 'src')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}

it('says 「加载中」 nowhere: loading shows as a skeleton', () => {
  const found = files(root).flatMap((path) => {
    const name = relative(root, path)
    if (ALLOWED[name]) return []
    const text = readFileSync(path, 'utf8')
    return WORDS.filter((word) => text.includes(word)).map(
      (word) => `${name}: ${word}`,
    )
  })
  expect(found).toEqual([])
})
