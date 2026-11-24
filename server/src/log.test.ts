import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { RotatingFile } from './log.ts'

test('the log file rotates by size and keeps a bounded number of files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-log-'))
  const file = path.join(dir, 'logs', 'midden.log')
  const stream = new RotatingFile(file, 100, 3)
  for (let i = 0; i < 10; i++) stream.write(`${String(i).repeat(59)}\n`)
  expect(readdirSync(path.dirname(file)).toSorted()).toEqual([
    'midden.log',
    'midden.log.1',
    'midden.log.2',
  ])
  expect(readFileSync(file, 'utf8')).toBe(`${'9'.repeat(59)}\n`)
  expect(readFileSync(`${file}.2`, 'utf8')).toBe(`${'7'.repeat(59)}\n`)
  // Reopening appends to the current file.
  new RotatingFile(file, 1000, 3).write('more\n')
  expect(readFileSync(file, 'utf8')).toBe(`${'9'.repeat(59)}\nmore\n`)
})
