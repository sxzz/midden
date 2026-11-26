import { rateLimitedKey } from '../platform.ts'
import { Metadata, status } from '../rpc.ts'

export class ProviderError extends Error {
  metadata = new Metadata()
  code: status
  constructor(code: status, message: string, retry?: string | null) {
    super(message)
    this.code = code
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry)
        : retry
          ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
          : 0
    if (seconds > 0)
      this.metadata.set('retry-after', String(Math.min(seconds, 86400)))
  }
}

export function credentialRequired(): never {
  const error = new ProviderError(
    status.FAILED_PRECONDITION,
    'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
  )
  error.metadata.set('credential-required', '1')
  throw error
}

export function responseError(
  code: number,
  account: boolean,
  retry?: string | null,
): ProviderError {
  if (code === 429) {
    const error = new ProviderError(
      status.RESOURCE_EXHAUSTED,
      'Instagram 请求过于频繁，请稍后重试',
      retry,
    )
    error.metadata.set(rateLimitedKey, '1')
    return error
  }
  if (code >= 500)
    return new ProviderError(
      status.UNAVAILABLE,
      'Instagram 暂时不可用，请稍后重试',
      retry,
    )
  if (code === 401)
    return new ProviderError(
      account ? status.UNAUTHENTICATED : status.FAILED_PRECONDITION,
      account
        ? 'Instagram 登录已失效，请重新添加账号授权'
        : 'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试',
    )
  if (code === 403)
    return new ProviderError(
      account ? status.PERMISSION_DENIED : status.FAILED_PRECONDITION,
      'Instagram 要求登录验证或账号无权访问，请检查账号后重试',
    )
  if (code === 404)
    return new ProviderError(
      status.NOT_FOUND,
      'Instagram 内容不存在或当前账号无权访问',
    )
  return new ProviderError(status.UNAVAILABLE, 'Instagram 返回的数据无效')
}
