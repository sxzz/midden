import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { pino, type Logger } from 'pino'

export type { Logger }

/**
 * Logs go to stdout and, given a file, to that file as well: the deploy
 * recreates the container, which drops the container's own log, so the
 * file under the data directory is what keeps them across versions.
 */
export function createLogger(level: string, file?: string): Logger {
  if (!file) return pino({ level })
  let stream: RotatingFile
  try {
    stream = new RotatingFile(file)
  } catch (error) {
    const logger = pino({ level })
    logger.warn({ err: error, file }, 'log file unavailable; logging to stdout')
    return logger
  }
  return pino(
    { level },
    pino.multistream([
      { level: level as pino.Level, stream: pino.destination(1) },
      { level: level as pino.Level, stream },
    ]),
  )
}

/**
 * An append-only log file that moves to `<file>.1` (and on to `.<keep - 1>`)
 * once it reaches `maxBytes`. Writes are synchronous; logging is light.
 */
export class RotatingFile {
  readonly file: string
  readonly maxBytes: number
  readonly keep: number
  #fd: number
  #size: number

  constructor(file: string, maxBytes = 10 << 20, keep = 5) {
    this.file = file
    this.maxBytes = maxBytes
    this.keep = keep
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#fd = fs.openSync(file, 'a')
    this.#size = fs.fstatSync(this.#fd).size
  }

  write(chunk: string): void {
    const bytes = Buffer.byteLength(chunk)
    try {
      if (this.#size > 0 && this.#size + bytes > this.maxBytes) this.#rotate()
      fs.writeSync(this.#fd, chunk)
      this.#size += bytes
    } catch {
      // A full disk must not take the process down; stdout still has it.
    }
  }

  #rotate(): void {
    fs.closeSync(this.#fd)
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`
      try {
        fs.renameSync(from, `${this.file}.${i}`)
      } catch {
        // Not there yet.
      }
    }
    this.#fd = fs.openSync(this.file, 'a')
    this.#size = 0
  }
}
