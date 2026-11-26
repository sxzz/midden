import {
  runRead,
  type ReadInput,
  type ReadName,
  type ReadOutput,
} from './reads.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { QueryPool } from './pool.ts'
import type { AgentReader, TypeCatalog } from './query.ts'

/** Where the agent API's reads run. */
export interface Reads {
  run: <N extends ReadName>(
    name: N,
    input: ReadInput<N>,
  ) => Promise<ReadOutput<N>>
  close: () => Promise<void>
}

/** On the read threads of a pool: what the web process uses. */
export function pooledReads(pool: QueryPool): Reads {
  return {
    run: (name, input) => pool.run(name, input) as Promise<never>,
    close: () => pool.close(),
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
