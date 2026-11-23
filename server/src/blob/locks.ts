/**
 * In-process mutual exclusion by key. The server is one process, so this is
 * enough to keep a download writing a media key and garbage collection
 * deleting it from interleaving.
 */
export class KeyedLock {
  readonly #held = new Map<string, Promise<void>>()

  isHeld(key: string): boolean {
    return this.#held.has(key)
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.#held.has(key)) await this.#held.get(key)
    let release!: () => void
    this.#held.set(key, new Promise((resolve) => (release = resolve)))
    try {
      return await fn()
    } finally {
      this.#held.delete(key)
      release()
    }
  }

  /** Run only if nobody holds the key; returns false otherwise. */
  async try<T>(key: string, fn: () => Promise<T>): Promise<boolean> {
    if (this.#held.has(key)) return false
    await this.run(key, fn)
    return true
  }
}
