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
  | 'invalid_folder'
  | 'invalid_tag'
  | 'invalid_slug'
  | 'invalid_cursor'
  | 'invalid_request'
  | 'no_more_pages'
  | 'batch_running'
  | 'collection_stopped'

const messages: Record<ErrorKind, string> = {
  invalid_target: '不支持的链接',
  not_found: '内容不存在或已删除',
  unsupported: '平台不支持此操作',
  conflict: '与之前的请求冲突，请刷新后重试',
  account_required: '此平台需要账号，请先在采集账号中添加并选择一个账号',
  connection: '账号不可用，请在采集账号中选择可用账号或重新授权',
  invalid_credential: '凭据无效或已过期',
  invalid_account: '账号请求无效',
  invalid_annotation: '备注最多 10000 字，标签名最多 64 字，标签最多 100 个',
  invalid_filter: '筛选条件无效',
  invalid_folder: '收藏夹名称不能为空，最多 64 字',
  invalid_tag: '标签名不能为空，最多 64 字',
  invalid_slug:
    '自定义链接只能用小写字母、数字和 -，3 到 64 个字符，不能以 - 开头或结尾',
  invalid_cursor: '翻页位置无效，请刷新后重试',
  invalid_request: '请求无效',
  no_more_pages: '没有更多帖子了',
  batch_running: '批量更新仍在进行',
  collection_stopped: '采集已中止',
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
