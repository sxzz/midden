import { sValidator } from '@hono/standard-validator'
import * as v from 'valibot'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Env = { Variables: { session: boolean } }

const invalid = (
  result: { success: boolean },
  c: { json: (body: { error: string }, status: 400) => Response },
) => {
  if (!result.success) return c.json({ error: 'invalid request' }, 400)
}

/** Validate a JSON body; invalid input is a plain 400 like any bad request. */
export const json = <T extends StandardSchemaV1>(schema: T) =>
  sValidator('json', schema, invalid)

/** Validate the query string; a repeated key arrives as an array. */
export const query = <T extends StandardSchemaV1>(schema: T) =>
  sValidator('query', schema, invalid)

/** A query with only a page cursor. */
export const Cursor = v.object({ cursor: v.optional(v.string()) })
