import { HTTPException } from 'hono/http-exception'
import { isBusy } from '#db/client.ts'
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
  invalid_folder: 400,
  invalid_tag: 400,
  invalid_slug: 400,
  invalid_annotation: 400,
  invalid_credential: 400,
  invalid_account: 400,
  dev_only: 403,
  not_found: 404,
  conflict: 409,
  no_more_pages: 409,
  collection_stopped: 409,
  account_required: 422,
  connection: 422,
  unsupported: 422,
}

/** Turn a thrown error into the JSON error response. */
export function errorResponse(c: Context, error: unknown, logger: Logger) {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status)
  // The write waited for the worker or a checkpoint as long as the web
  // process may: trying again shortly succeeds.
  if (isBusy(error)) {
    logger.warn({ path: c.req.path }, 'request found the database locked')
    c.header('Retry-After', '1')
    return c.json({ error: '数据库繁忙，请重试' }, 503)
  }
  if (isAppError(error))
    return c.json({ error: error.message }, statuses[error.kind])
  if (
    isProviderFailure(error) &&
    (error.code === status.UNAVAILABLE ||
      error.code === status.DEADLINE_EXCEEDED)
  )
    return c.json({ error: '采集服务暂时不可用' }, 503)
  logger.error({ err: error, path: c.req.path }, 'request failed')
  return c.json({ error: '服务内部错误' }, 500)
}

export function badRequest(message = '请求无效'): HTTPException {
  return new HTTPException(400, { message })
}
