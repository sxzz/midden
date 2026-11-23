import { HTTPException } from 'hono/http-exception'
import { isAppError, type ErrorKind } from '#errors.ts'
import { isProviderFailure } from '#platforms/platform.ts'
import { status } from '#platforms/rpc.ts'
import type { Logger } from '#log.ts'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

const statuses: Record<ErrorKind, ContentfulStatusCode> = {
  invalid_target: 400,
  invalid_cursor: 400,
  invalid_request: 400,
  invalid_filter: 400,
  invalid_annotation: 400,
  invalid_credential: 400,
  invalid_account: 400,
  not_found: 404,
  conflict: 409,
  no_more_pages: 409,
  batch_running: 409,
  collection_stopped: 409,
  account_required: 422,
  connection: 422,
  unsupported: 422,
}

// The web app matches these texts to show its own wording.
const texts: Partial<Record<ErrorKind, string>> = {
  invalid_target: 'unsupported URL',
}

/** Turn a thrown error into the JSON error response. */
export function errorResponse(c: Context, error: unknown, logger: Logger) {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status)
  if (isAppError(error))
    return c.json(
      { error: texts[error.kind] ?? error.message },
      statuses[error.kind],
    )
  if (
    isProviderFailure(error) &&
    (error.code === status.UNAVAILABLE ||
      error.code === status.DEADLINE_EXCEEDED)
  )
    return c.json({ error: 'adapter temporarily unavailable' }, 503)
  logger.error({ err: error, path: c.req.path }, 'request failed')
  return c.json({ error: 'internal error' }, 500)
}

export function badRequest(message = 'invalid request'): HTTPException {
  return new HTTPException(400, { message })
}
