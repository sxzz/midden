import { Buffer } from 'node:buffer'

/**
 * The start of a JPEG of the given pixel size: enough for the media type
 * and the size to be read from it. `salt` makes files of one size differ.
 */
export function jpegOf(width: number, height: number, salt = ''): Buffer {
  const frame = Buffer.alloc(19)
  frame.writeUInt16BE(0xffc0, 0)
  frame.writeUInt16BE(17, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  frame[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from(salt)])
}
