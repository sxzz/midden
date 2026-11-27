import { sValidator } from '@hono/standard-validator'
import * as v from 'valibot'
import type { TokenInfo } from '#tokens/tokens.ts'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * `session`: the owner's web session, which alone may delete and manage
 * tokens, sessions, passkeys and domains (`ownerOnly`);
 * `sessionId`: that session's public id, when a cookie signed the request
 * in (not on a read thread, nor a development token standing in for it);
 * `token`: the API token the request came with, if any.
 */
export type Env = {
  Variables: { session: boolean; sessionId?: string; token?: TokenInfo }
}

const invalid = (
  result: { success: boolean },
  c: { json: (body: { error: string }, status: 400) => Response },
) => {
  if (!result.success) return c.json({ error: '请求无效' }, 400)
}

/** Validate a JSON body; invalid input is a plain 400 like any bad request. */
export const json = <T extends StandardSchemaV1>(schema: T) =>
  sValidator('json', schema, invalid)

/** Validate the query string; a repeated key arrives as an array. */
export const query = <T extends StandardSchemaV1>(schema: T) =>
  sValidator('query', schema, invalid)

/** A query with only a page cursor. */
export const Cursor = v.object({ cursor: v.optional(v.string()) })
