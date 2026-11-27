import { PoolError, ThreadError, type QueryPool } from '#reads/pool.ts'
import { AgentError, type ErrorBody } from './errors.ts'
import {
  runRead,
  type ReadInput,
  type ReadName,
  type ReadOutput,
} from './reads.ts'
import type { NamedReadRequest } from '#http/offload.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { Principal } from '#users/principal.ts'
import type { ReadBase, TypeCatalog } from './query.ts'

/** Where the agent API's reads run, each for a principal. */
export interface Reads {
  run: <N extends ReadName>(
    principal: Principal,
    name: N,
    input: ReadInput<N>,
  ) => Promise<ReadOutput<N>>
  close: () => Promise<void>
}

/** What the agent API answers when the pool could not run a read. */
function agentError(error: unknown): unknown {
  if (error instanceof ThreadError) {
    const body = error.body as ErrorBody
    return new AgentError(body.error, body.message, body.detail, body.position)
  }
  if (!(error instanceof PoolError)) return error
  switch (error.code) {
    case 'busy':
      return new AgentError('busy', error.message)
    case 'timeout':
      return new AgentError(
        'query_timeout',
        `The query took longer than ${error.timeoutMs / 1000} s. Narrow it (a folder, dates, an author, fewer words) and retry.`,
      )
    case 'lost':
      return new AgentError('internal', 'Internal error.')
  }
}

/**
 * On the read threads of the pool the web app shares: what the web process
 * uses. The pool closes with the web process, not with the agent API.
 */
export function pooledReads(pool: QueryPool): Reads {
  return {
    run: (principal, name, input) =>
      pool
        .run('agent', name, { principal, input } satisfies NamedReadRequest)
        .catch((error: unknown) => {
          throw agentError(error)
        }) as Promise<never>,
    close: () => Promise.resolve(),
  }
}

/**
 * On this thread, for tests: the same reads, with results copied as a
 * thread's would be.
 */
export function inlineReads(reader: ReadBase): Reads {
  return {
    run: async (principal, name, input) =>
      structuredClone(
        await runRead({ ...reader, principal }, name, input),
      ) as never,
    close: () => Promise.resolve(),
  }
}

/** The entity types of the platforms, as lists of posts and accounts read. */
export function typeCatalog(platforms: Platforms): TypeCatalog {
  return platforms.types()
}
