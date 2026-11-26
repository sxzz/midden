import { PoolError, ThreadError, type QueryPool } from '#reads/pool.ts'
import { AgentError, type ErrorBody } from './errors.ts'
import {
  runRead,
  type ReadInput,
  type ReadName,
  type ReadOutput,
} from './reads.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { AgentReader, TypeCatalog } from './query.ts'

/** Where the agent API's reads run. */
export interface Reads {
  run: <N extends ReadName>(
    name: N,
    input: ReadInput<N>,
  ) => Promise<ReadOutput<N>>
  close: () => Promise<void>
}

/** What the agent API answers when the pool could not run a read. */
function agentError(error: unknown): unknown {
  if (error instanceof ThreadError) {
    const body = error.body as ErrorBody
    return new AgentError(body.error, body.message, body.detail)
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
    run: (name, input) =>
      pool.run('agent', name, input).catch((error: unknown) => {
        throw agentError(error)
      }) as Promise<never>,
    close: () => Promise.resolve(),
  }
}

/**
 * On this thread, for tests: the same reads, with results copied as a
 * thread's would be.
 */
export function inlineReads(reader: AgentReader): Reads {
  return {
    run: async (name, input) =>
      structuredClone(await runRead(reader, name, input)) as never,
    close: () => Promise.resolve(),
  }
}

/** The entity types of the platforms, as lists of posts and accounts read. */
export function typeCatalog(platforms: Platforms): TypeCatalog {
  const all = platforms.all()
  const names = all.flatMap((p) => p.description.entityTypes.map((t) => t.name))
  return {
    platforms: all.map((p) => p.description.adapterId).toSorted(),
    posts: names.filter((n) => !n.endsWith('.profile')).toSorted(),
    accounts: names.filter((n) => n.endsWith('.profile')).toSorted(),
  }
}
