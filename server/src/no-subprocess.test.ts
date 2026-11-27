import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The server runs no programs: thumbnails and media sizes come from the
// platforms (`capture/thumbnail.ts`), and the image has no ffmpeg. Tests
// may start processes (the server itself, say); nothing else may.

const root = fileURLToPath(new URL('../..', import.meta.url))
const SUBPROCESS = /\bchild_process\b/
const FFMPEG = /\bff(?:mpeg|probe)\b/i

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = path.join(dir, entry.name)
      if (entry.isDirectory())
        return entry.name === 'node_modules' ? [] : files(name)
      return /\.(?:ts|vue|mjs|js)$/.test(entry.name) ? [name] : []
    },
  )
}

const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

test('no server code starts a process', () => {
  const offending = files('server/src').filter(
    (file) => !/\.test\.ts$/.test(file) && SUBPROCESS.test(read(file)),
  )
  expect(offending).toEqual([])
})

test('nothing names ffmpeg or ffprobe any more', () => {
  const offending = [
    ...files('server/src'),
    ...files('server/scripts'),
    ...files('web/src'),
    'Dockerfile',
    'mise.toml',
    'compose.yaml',
    '.github/actions/setup/action.yml',
    '.github/workflows/test.yml',
  ].filter(
    (file) =>
      file !== 'server/src/no-subprocess.test.ts' && FFMPEG.test(read(file)),
  )
  expect(offending).toEqual([])
})
