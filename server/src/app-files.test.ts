import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// The server writes no files of its own besides the database and the media
// store: logs go to stdout, and the web process and the worker ask each
// other how they are doing over HTTP (`runtime/internal.ts`). These modules
// may use the file system, each for the reason given; anything else that
// imports `node:fs` fails here. Tests, the test helpers and the CLI (backups,
// migrations of media) are left out.
const WRITERS: Record<string, string> = {
  'blob/fs-store.ts': 'the media store',
  'blob/staging.ts': 'downloads staged before they enter the media store',
  'capture/thumbnail.ts': 'ffmpeg works in the staging directory',
  'db/client.ts': "the database's directory",
  'db/maintain.ts': 'the database: a vacuum into a copy that replaces it',
}
// These only read.
const READERS: Record<string, string> = {
  'blob/digest.ts': 'hashes media files',
  'blob/s3.ts': 'uploads media files',
  'capture/download.ts': 'reads back a staged download',
  'usage/local.ts': 'sizes of the data directory and the disk',
  'usage/composition.ts': "the database file's size",
  'usage/composition-worker.ts': 'sizes of the media files',
  'agent/doc.ts': "the agent API's guide, shipped with the server",
}
const READ = new Set([
  'createReadStream',
  'existsSync',
  'lstat',
  'open',
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'statfs',
])

const SRC = path.dirname(fileURLToPath(import.meta.url))
// Imports are formatted (prettier): single spaces, names in braces.
const IMPORT =
  /import (?:type )?(\{[^}]*\}|\* as \w+|\w+) from 'node:fs(?:\/promises)?'/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'testing' ? [] : sources(file)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path.relative(SRC, file)]
      : []
  })
}

/** What each module imports from `node:fs`, by name ('*' for all of it). */
function fsImports(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of sources(SRC)) {
    if (file === 'cli.ts') continue
    const text = readFileSync(path.join(SRC, file), 'utf8')
    const names = [...text.matchAll(IMPORT)].flatMap(([, what]) =>
      what!.startsWith('{')
        ? what!
            .slice(1, -1)
            .split(',')
            .map((name) => name.trim().split(/\s+as\s+/, 1)[0]!)
            .filter(Boolean)
        : ['*'],
    )
    if (text.includes("import('node:fs")) names.push('*')
    if (names.length) found.set(file.split(path.sep).join('/'), names)
  }
  return found
}

describe('files', () => {
  test('only the database and the media store touch the file system', () => {
    const imports = fsImports()
    const unexpected = [...imports.keys()].filter(
      (file) => !(file in WRITERS) && !(file in READERS),
    )
    expect(unexpected).toEqual([])
    const writing = [...imports].flatMap(([file, names]) =>
      file in READERS
        ? names.filter((name) => !READ.has(name)).map((n) => `${file}: ${n}`)
        : [],
    )
    expect(writing).toEqual([])
  })

  test('the lists name modules that exist', () => {
    const imports = fsImports()
    for (const file of [...Object.keys(WRITERS), ...Object.keys(READERS)])
      expect(imports.has(file), file).toBe(true)
  })
})
