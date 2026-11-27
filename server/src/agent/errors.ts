import { isBusy } from '#db/client.ts'
import { hasDefaultMessage, isAppError, type ErrorKind } from '#errors.ts'
import { QueryError } from '#query/ast.ts'

/** Every error the agent API answers with; `docs/agent.md` lists them. */
export const AGENT_ERRORS = {
  invalid_request: 400,
  query_invalid: 400,
  cursor_mismatch: 400,
  token_invalid: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  internal: 500,
  busy: 503,
  query_timeout: 503,
} as const

export type AgentErrorCode = keyof typeof AGENT_ERRORS

/** An error with its code and an English message, as the API answers it. */
export class AgentError extends Error {
  override name = 'AgentError'
  readonly code: AgentErrorCode
  readonly detail?: string
  /** Where in the query (`q`) the problem is, with `query_invalid`. */
  readonly position?: number
  constructor(
    code: AgentErrorCode,
    message: string,
    detail?: string,
    position?: number,
  ) {
    super(message)
    this.code = code
    if (detail) this.detail = detail
    if (position !== undefined) this.position = position
  }
}

export const invalid = (message: string) =>
  new AgentError('invalid_request', message)

export const notFound = (what = 'Not found, or not in the archive.') =>
  new AgentError('not_found', what)

const byKind: Record<ErrorKind, [AgentErrorCode, string]> = {
  invalid_target: ['invalid_request', 'Unsupported link.'],
  invalid_cursor: [
    'cursor_mismatch',
    'The cursor belongs to another query. Start again without it.',
  ],
  invalid_request: ['invalid_request', 'Invalid request.'],
  invalid_filter: ['invalid_request', 'Invalid filter.'],
  invalid_folder: ['invalid_request', 'Invalid folder name.'],
  invalid_tag: ['invalid_request', 'Invalid tag name.'],
  invalid_slug: ['invalid_request', 'Invalid slug.'],
  invalid_annotation: [
    'invalid_request',
    'Notes hold at most 10000 characters, tag names 64, and at most 100 tags.',
  ],
  invalid_credential: ['invalid_request', 'Invalid credential.'],
  invalid_account: ['invalid_request', 'Invalid account request.'],
  dev_only: ['forbidden', 'Only on a development server.'],
  not_found: ['not_found', 'Not found, or not in the archive.'],
  conflict: ['conflict', 'Conflicts with the current state.'],
  no_more_pages: ['conflict', 'There are no older posts to read.'],
  collection_stopped: ['conflict', 'The capture was stopped.'],
  account_required: [
    'unprocessable',
    'This platform needs a capture account; the owner has to add one.',
  ],
  connection: [
    'unprocessable',
    'The capture account cannot be used; the owner has to fix it.',
  ],
  unsupported: ['unprocessable', 'The platform does not support this.'],
}

export interface ErrorBody {
  error: AgentErrorCode
  message: string
  /** The archive's own words (Chinese), when they say more. */
  detail?: string
  /** `query_invalid`: offset into `q` (UTF-16 code units). */
  position?: number
}

/** What an error thrown by a handler or a read answers. */
export function errorBody(error: unknown): ErrorBody {
  if (error instanceof AgentError)
    return {
      error: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.position === undefined ? {} : { position: error.position }),
    }
  if (error instanceof QueryError)
    return {
      error: 'query_invalid',
      message: error.message,
      position: error.position,
    }
  if (isAppError(error)) {
    const [code, message] = byKind[error.kind]
    return hasDefaultMessage(error)
      ? { error: code, message }
      : { error: code, message, detail: error.message }
  }
  if (isBusy(error))
    return {
      error: 'busy',
      message: 'The database is busy. Retry after a few seconds.',
    }
  return { error: 'internal', message: 'Internal error.' }
}
