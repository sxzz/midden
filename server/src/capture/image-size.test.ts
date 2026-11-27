import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { imageSize } from './image-size.ts'

describe('imageSize', () => {
  test('reads a lossy, a lossless and an extended WebP header', () => {
    const lossy = Buffer.alloc(30)
    lossy.write('RIFF', 0)
    lossy.write('WEBP', 8)
    lossy.write('VP8 ', 12)
    lossy.writeUInt16LE(640, 26)
    // The top two bits of the height are a scaling hint, not size.
    lossy.writeUInt16LE(0x4000 | 100, 28)
    expect(imageSize(lossy)).toEqual({ width: 640, height: 100 })

    const lossless = Buffer.alloc(30)
    lossless.write('RIFF', 0)
    lossless.write('WEBP', 8)
    lossless.write('VP8L', 12)
    lossless[20] = 0x2f
    lossless.writeUInt32LE((1200 - 1) | ((200 - 1) << 14), 21)
    expect(imageSize(lossless)).toEqual({ width: 1200, height: 200 })

    const extended = Buffer.alloc(30)
    extended.write('RIFF', 0)
    extended.write('WEBP', 8)
    extended.write('VP8X', 12)
    extended.writeUIntLE(1200 - 1, 24, 3)
    extended.writeUIntLE(60 - 1, 27, 3)
    expect(imageSize(extended)).toEqual({ width: 1200, height: 60 })
  })

  test('skips other JPEG segments to the frame header', () => {
    const app = Buffer.alloc(10 + 2)
    app.writeUInt16BE(0xffe1, 0)
    app.writeUInt16BE(10, 2)
    const dht = Buffer.from([0xff, 0xc4, 0, 4, 0, 0])
    const frame = Buffer.alloc(11)
    frame.writeUInt16BE(0xffc0, 0)
    frame.writeUInt16BE(11, 2)
    frame[4] = 8
    frame.writeUInt16BE(300, 5)
    frame.writeUInt16BE(1800, 7)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app, dht, frame])
    expect(imageSize(jpeg)).toEqual({ width: 1800, height: 300 })
  })

  test('reads a PNG header', () => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12)
    png.writeUInt32BE(622, 16)
    png.writeUInt32BE(680, 20)
    expect(imageSize(png)).toEqual({ width: 622, height: 680 })
  })

  test('is undefined for other formats and truncated files', () => {
    expect(imageSize(Buffer.from('GIF89a....................'))).toBeUndefined()
    expect(
      imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])),
    ).toBeUndefined()
    expect(imageSize(Buffer.alloc(0))).toBeUndefined()
  })
})
