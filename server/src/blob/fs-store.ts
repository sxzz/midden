import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  assertBlobKey,
  type BlobStore,
  type ByteRange,
  type MediaUrlOptions,
} from './store.ts'
import type { MediaSigner } from './signer.ts'
import type { Readable } from 'node:stream'

/** Media in a local directory, served by this process through signed URLs. */
export class FsBlobStore implements BlobStore {
  readonly #root: string
  readonly #signer: MediaSigner

  constructor(root: string, signer: MediaSigner) {
    this.#root = root
    this.#signer = signer
  }

  #path(key: string): string {
    assertBlobKey(key)
    // Two levels of fan-out keep directories small.
    return path.join(this.#root, key.slice(0, 2), key.slice(2, 4), key)
  }

  async putFile(key: string, file: string): Promise<void> {
    const target = this.#path(key)
    // Content-addressed: an existing object already holds these bytes.
    if ((await this.stat(key)) !== undefined) {
      await rm(file, { force: true })
      return
    }
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await rename(file, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      // Staged on another filesystem: copy beside the target, then rename,
      // so a crash never leaves a partial object under the final name.
      const temporary = `${target}.${randomUUID()}.part`
      await copyFile(file, temporary)
      const handle = await open(temporary, 'r+')
      await handle.sync()
      await handle.close()
      await rename(temporary, target)
      await rm(file, { force: true })
    }
  }

  async stat(key: string): Promise<number | undefined> {
    try {
      return (await stat(this.#path(key))).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  read(key: string, range?: ByteRange): Promise<Readable> {
    const stream = createReadStream(this.#path(key), range)
    // Surface a missing file as a rejection instead of a stream error.
    return new Promise((resolve, reject) => {
      stream.once('open', () => resolve(stream))
      stream.once('error', reject)
    })
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true })
  }

  url(key: string, options: MediaUrlOptions): string {
    assertBlobKey(key)
    return this.#signer.sign({ key, ...options })
  }
}
