/**
 * Errors with a meaning callers act on. `kind` decides the HTTP status and
 * whether a background job retries.
 */
export type ErrorKind =
  | 'invalid_target'
  | 'not_found'
  | 'unsupported'
  | 'conflict'
  | 'account_required'
  | 'connection'
  | 'invalid_credential'
  | 'invalid_account'
  | 'invalid_annotation'
  | 'invalid_filter'
  | 'invalid_cursor'
  | 'invalid_request'
  | 'no_more_pages'
  | 'batch_running'
  | 'collection_stopped'

const messages: Record<ErrorKind, string> = {
  invalid_target: 'invalid or unsupported URL',
  not_found: 'not found',
  unsupported: 'provider operation is not supported',
  conflict: 'idempotency key conflicts with an earlier request',
  account_required: 'account required; add and select your own credentials',
  connection: 'account unavailable; choose a source or authorize again',
  invalid_credential: 'invalid credentials',
  invalid_account: 'invalid account request',
  invalid_annotation: 'invalid note or tags',
  invalid_filter: 'invalid collection filters',
  invalid_cursor: 'invalid cursor',
  invalid_request: 'invalid request',
  no_more_pages: 'no more pages',
  batch_running: 'refresh batch is still running',
  collection_stopped: 'collection stopped',
}

export class AppError extends Error {
  override name = 'AppError'
  readonly kind: ErrorKind
  constructor(kind: ErrorKind, message = messages[kind]) {
    super(message)
    this.kind = kind
  }
}

export function isAppError(
  error: unknown,
  kind?: ErrorKind,
): error is AppError {
  return (
    error instanceof AppError && (kind === undefined || error.kind === kind)
  )
}
