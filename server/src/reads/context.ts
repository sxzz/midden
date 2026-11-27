// The context a read thread's API runs with (`thread.ts`). Apart from the
// thread so that tests can read through exactly this context in process.
import { KeyedLock } from '#blob/locks.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { ReadContext } from '#library/views.ts'
import type { Logger } from '#log.ts'
import type { CountPointers, Platforms } from '#platforms/registry.ts'

/**
 * What a read thread lacks, but for the plain parts in `present`: using the
 * rest means the route belongs on the web process's thread (`inline`).
 */
function absent<T extends object>(what: string, present: Partial<T> = {}): T {
  return new Proxy(present as T, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key as keyof T]
      throw new Error(
        `${what} (${String(key)}) is not on a read thread; mark the route inline`,
      )
    },
  })
}

/**
 * The context the web process's API reads with, on a read thread: what a
 * `ReadContext` has, and the rest of the web process's context refusing to
 * be used.
 */
export function threadContext(
  reader: Pick<ReadContext, 'db' | 'blobs'>,
  countPointers: CountPointers,
  logger: Logger,
): AccountsContext {
  const read: ReadContext = {
    db: reader.db,
    blobs: reader.blobs,
    platforms: { countPointers: () => countPointers },
  }
  return {
    ...read,
    logger,
    queue: absent('the job queue'),
    platforms: absent<Platforms>('the platforms', read.platforms),
    vault: absent('the credential vault'),
    openCredential: () => {
      throw new Error('credentials are not on a read thread')
    },
    stagingDir: '',
    mediaLocks: new KeyedLock(),
  }
}
