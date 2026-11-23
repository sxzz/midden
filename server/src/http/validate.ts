import { sValidator } from '@hono/standard-validator'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Env = { Variables: { session: boolean } }

/** Validate a JSON body; invalid input is a plain 400 like any bad request. */
export const json = <T extends StandardSchemaV1>(schema: T) =>
  sValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid request' }, 400)
  })
