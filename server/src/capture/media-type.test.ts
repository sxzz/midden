import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { sniffMediaType } from './media-type.ts'

const ftyp = (brand: string, size = 24, length = size) => {
  const head = Buffer.alloc(length)
  head.writeUInt32BE(size, 0)
  head.write('ftyp', 4, 'latin1')
  head.write(brand, 8, 'latin1')
  return head
}

describe('sniffMediaType', () => {
  test.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    [Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png'],
    [Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), 'image/webp'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm'],
    [ftyp('mp42'), 'video/mp4'],
    [ftyp('mp41').fill('mp4', 16, 19), 'video/mp4'],
    [ftyp('isom'), 'video/mp4'],
    [ftyp('M4V '), 'video/mp4'],
    [ftyp('avif'), 'application/octet-stream'],
    [ftyp('heic'), 'application/octet-stream'],
    [ftyp('M4A '), 'application/octet-stream'],
    [ftyp('isom', 4096, 64), 'application/octet-stream'],
    [ftyp('isom').subarray(0, 15), 'application/octet-stream'],
    [Buffer.from('GIF89a'), 'application/octet-stream'],
    [Buffer.from('<!doctype html>'), 'application/octet-stream'],
  ])('%#', (head, expected) => {
    expect(sniffMediaType(head)).toBe(expected)
  })
})
