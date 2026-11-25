import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Thumbnailer } from '#capture/context.ts'

// Reads its input as ffmpeg does a video: the start, then the end (where an
// MP4 may keep its index), by byte ranges from a URL. The "thumbnail" is a
// JPEG marker, the input's first 16 bytes and the contents of `version`.
const SCRIPT = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = new URL('.', import.meta.url)
const args = process.argv.slice(2)
appendFileSync(new URL('calls', dir), JSON.stringify(args) + '\n')
const input = args[args.indexOf('-i') + 1]
const output = args.at(-1)
let head
if (/^https?:/.test(input)) {
  for (const range of ['bytes=0-15', 'bytes=-4']) {
    const response = await fetch(input, { headers: { Range: range } })
    if (response.status !== 206) process.exit(1)
    const bytes = Buffer.from(await response.arrayBuffer())
    head ??= bytes
  }
} else {
  head = readFileSync(input).subarray(0, 16)
}
const version = new URL('version', dir)
writeFileSync(output, Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  head,
  existsSync(version) ? readFileSync(version) : Buffer.alloc(0),
]))
`

/** A stand-in for ffmpeg that records its calls. */
export function fakeFfmpeg() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ffmpeg-'))
  const script = path.join(dir, 'ffmpeg.mjs')
  writeFileSync(script, SCRIPT)
  chmodSync(script, 0o755)
  const thumbnailer: Thumbnailer = { ffmpeg: script, encoder: 'mjpeg' }
  return {
    thumbnailer,
    /** Argument lists, oldest first. */
    calls(): string[][] {
      const file = path.join(dir, 'calls')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    },
    /** Change what it renders from now on, as another ffmpeg might. */
    setVersion(version: string) {
      writeFileSync(path.join(dir, 'version'), version)
    },
  }
}
