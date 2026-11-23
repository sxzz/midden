import { isAppError } from '#errors.ts'
import { PermanentError, RetryError } from '#jobs/queue.ts'
import { isProviderFailure } from '#platforms/platform.ts'
import { status } from '#platforms/rpc.ts'

// Platform statuses that retrying cannot fix.
const PERMANENT_STATUS = new Set<number>([
  status.INVALID_ARGUMENT,
  status.FAILED_PRECONDITION,
  status.UNIMPLEMENTED,
  status.PERMISSION_DENIED,
  status.UNAUTHENTICATED,
])

export function isPermanent(error: unknown): boolean {
  if (error instanceof RetryError) return false
  if (error instanceof PermanentError) return true
  if (isAppError(error))
    return ['not_found', 'unsupported', 'connection'].includes(error.kind)
  return isProviderFailure(error) && PERMANENT_STATUS.has(error.code)
}

/** The message stored on failed captures and assets and shown to users. */
export function safeError(error: unknown): string {
  if (error instanceof RetryError && error.cause !== undefined)
    return safeError(error.cause)
  if (isAppError(error, 'account_required'))
    return '此平台需要账号，请先在采集账号中添加并选择一个账号。'
  if (isAppError(error, 'connection'))
    return '账号不可用，请在采集账号中选择可用账号或重新授权。'
  if (isAppError(error, 'unsupported')) return '平台不支持此操作'
  if (error instanceof PermanentError) return error.message
  if (isProviderFailure(error)) return error.message
  return '服务内部错误'
}

export const MAX_RETRY_AFTER = 86_400
const DIGITS = /^\d+$/

/** A platform's `retry-after` trailer, in seconds, when valid. */
export function retryAfter(error: unknown): number | undefined {
  if (!isProviderFailure(error)) return undefined
  const [value] = error.metadata.get('retry-after')
  if (!value || !DIGITS.test(value)) return undefined
  const seconds = Number(value)
  return seconds > 0 && seconds <= MAX_RETRY_AFTER ? seconds : undefined
}

export function sourceState(
  error: unknown,
): 'deleted' | 'suspended' | undefined {
  if (!isProviderFailure(error)) return undefined
  const [value] = error.metadata.get('source-state')
  return value === 'deleted' || value === 'suspended' ? value : undefined
}

export function credentialRequired(error: unknown): boolean {
  return (
    isProviderFailure(error) &&
    error.metadata.get('credential-required')[0] === '1'
  )
}
