import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'

// The web's copy puts no plain space between Chinese (or kana) and a Latin
// letter or digit: 「已删除3个视频」, 「API令牌」. The browser draws the gap
// itself (`text-autospace` in style.css), so a typed space would show twice
// as wide. Spaces that stay: inside a number and its unit (「12.3 GB」,
// 「300 ms」), inside dates and times, between two ASCII words, and around
// what the reader or a platform wrote (names, handles), which are
// interpolated and so not looked at here.
const CJK = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`
const SPACED = new RegExp(String.raw`${CJK} [a-z\d]|[a-z\d] ${CJK}`, 'iu')
/** Lines that keep such a space, each with why. */
const ALLOWED: Record<string, string> = {
  // A command is typed as it is shown: spaces around it.
  '发送 /passkey 添加': 'the /passkey command stands apart',
}

/** Files left out, each with why. */
const SKIPPED: Record<string, string> = {
  // Query examples are typed as written (`猫 OR 狗`); the help is restyled
  // elsewhere, its copy with it.
  'components/QueryHelp.vue': 'query syntax, spaced as typed',
}

// Tests run from the web package (its vitest config).
const root = join(process.cwd(), 'src')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(?:ts|vue)$/.test(entry.name) && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

/** The source without its comments, which are not copy. */
function withoutComments(text: string) {
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

it('puts no space between Chinese and Latin letters or digits in copy', () => {
  const found = files(root).flatMap((path) => {
    const name = relative(root, path)
    if (name.startsWith('testing/') || SKIPPED[name]) return []
    return withoutComments(readFileSync(path, 'utf8'))
      .split('\n')
      .filter(
        (line) =>
          SPACED.test(line) &&
          Object.keys(ALLOWED).every((kept) => !line.includes(kept)),
      )
      .map((line) => `${name}: ${line.trim()}`)
  })
  expect(found).toEqual([])
})
