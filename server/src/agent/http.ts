import * as v from 'valibot'
import { AGENT_ERRORS, errorBody, invalid } from './errors.ts'
import { RETRY_AFTER_S } from './gate.ts'
import type { TokenInfo } from '#tokens/tokens.ts'
import type { Principal } from '#users/principal.ts'
import type { Params } from './query.ts'
import type { Context } from 'hono'

export type AgentEnv = {
  Variables: { token: TokenInfo; principal: Principal }
}

/** Scheme and host as the client called them, for absolute links. */
export function originOf(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('X-Forwarded-Proto')?.split(',', 1)[0]?.trim()
  const scheme =
    proto === 'https' || proto === 'http' ? proto : url.protocol.slice(0, -1)
  return `${scheme}://${url.host}`
}

/** The query string, a repeated key with several values. */
export const queries = (c: Context): Params => c.req.queries() ?? {}

/** `{"error": code, "message": …}` with the code's status. */
export function errorResponse(c: Context, error: unknown) {
  const body = errorBody(error)
  if (body.error === 'busy') c.header('Retry-After', String(RETRY_AFTER_S))
  return c.json(body, AGENT_ERRORS[body.error])
}

/** A JSON body checked against a schema; any problem is `invalid_request`. */
export async function body<T extends v.GenericSchema>(
  c: Context,
  schema: T,
): Promise<v.InferOutput<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalid('The body must be JSON.')
  }
  const parsed = v.safeParse(schema, raw)
  if (!parsed.success)
    throw invalid(
      `Invalid body: ${parsed.issues
        .map((i) => `${v.getDotPath(i) ?? 'body'}: ${i.message}`)
        .join('; ')}`,
    )
  return parsed.output
}
