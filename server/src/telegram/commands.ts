import { Buffer } from 'node:buffer'
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import {
  listAccounts,
  revokeAccount,
  selectAccount,
  type AccountsContext,
} from '#accounts/accounts.ts'
import { retryRefreshBatch } from '#capture/batches.ts'
import { safeError } from '#capture/errors.ts'
import { sha256Hex } from '#capture/json.ts'
import { captureURL, recapture, recordPage } from '#capture/records.ts'
import { stopCollection } from '#capture/related.ts'
import { captures, connections, library } from '#db/schema.ts'
import { AppError, isAppError } from '#errors.ts'
import { deleteCollection } from '#library/delete.ts'
import { getCollection } from '#library/read.ts'
import { enqueueDelivery } from './delivery.ts'
import {
  COMMANDS,
  helpText,
  jobState,
  MENU_BUTTONS,
  webRoute,
  type Keyboard,
} from './presentation.ts'
import { formatBytes, summaryLine } from './text.ts'
import type { MessageEntity } from 'grammy/types'

export interface Request {
  command: string
  arg: string
  group: boolean
  chatId: string
  /** The message that asked (in groups, replies go to it). */
  messageId: number
  updateId: number
  links: string[]
}

export interface Reply {
  text?: string
  entities?: MessageEntity[]
  keyboard?: Keyboard
  /** Shown as a toast when the request came from a button. */
  toast?: string
  /** Never edit the button's message; send a new one. */
  newMessage?: boolean
}

export interface CommandContext {
  ctx: AccountsContext
  webAppUrl?: string
  version: string
}

const MAX_LINKS = 200
const LIST_PAGE = 10
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const GENERIC = '操作失败，使用 /help 查看用法。'

const menu = (text: string, extra: Partial<Reply> = {}): Reply => ({
  text,
  keyboard: MENU_BUTTONS,
  ...extra,
})

function requireId(arg: string): string {
  if (!UUID.test(arg)) throw new AppError('invalid_request')
  return arg
}

/** Run one command; domain errors become the generic reply. */
export function handle(c: CommandContext, request: Request): Reply {
  const info = COMMANDS.find((command) => command.name === request.command)
  if (request.group && info?.privateOnly) return menu('请在私聊中使用此命令。')
  try {
    return run(c, request)
  } catch (error) {
    if (isAppError(error)) return menu(GENERIC)
    c.ctx.logger.error(
      { err: error, command: request.command },
      'command failed',
    )
    return menu(GENERIC)
  }
}

function deliverSubmission(
  c: CommandContext,
  request: Request,
  submissionId: string,
) {
  enqueueDelivery(c.ctx, {
    kind: 'submission',
    ref: submissionId,
    chatId: request.chatId,
    group: request.group,
    replyTo: request.group ? request.messageId : undefined,
  })
}

function run(c: CommandContext, request: Request): Reply {
  const { ctx } = c
  const { arg } = request
  switch (request.command) {
    case 'start':
    case 'help': {
      let text = helpText(request.group)
      const entities: MessageEntity[] = []
      const keyboard: Keyboard = [...MENU_BUTTONS]
      if (request.command === 'start') {
        text += '\n\n版本：'
        entities.push({
          type: 'code',
          offset: text.length,
          length: c.version.length,
        })
        text += c.version
        if (c.webAppUrl)
          keyboard.push([{ text: '打开', web_app: { url: c.webAppUrl } }])
      }
      return {
        text,
        entities,
        keyboard,
        newMessage: request.command === 'start' && !!c.webAppUrl,
      }
    }
    case 'save':
      return save(c, request)
    case 'list':
      return list(c, arg)
    case 'show':
      getCollection(ctx, requireId(arg))
      enqueueDelivery(ctx, {
        kind: 'show',
        ref: arg,
        chatId: request.chatId,
        group: request.group,
        replyTo: request.group ? request.messageId : undefined,
      })
      return {}
    case 'status': {
      const capture = ctx.db
        .select()
        .from(captures)
        .where(eq(captures.id, requireId(arg)))
        .get()
      if (!capture) throw new AppError('not_found')
      const keyboard: Keyboard = [
        [{ text: '更新状态', callback_data: `/status ${capture.id}` }],
      ]
      if (capture.state === 'complete' || capture.state === 'partial')
        keyboard.push([
          { text: '查看收藏', callback_data: `/show ${capture.collectionId}` },
        ])
      return { text: `${jobState(capture.state)}\n${capture.error}`, keyboard }
    }
    case 'retry':
    case 'refresh': {
      const job = recapture(ctx, requireId(arg), {
        restart: request.command === 'retry',
        key: `${request.command}:${request.updateId}`,
      })
      deliverSubmission(c, request, job.submissionId)
      return {}
    }
    case 'delete':
      try {
        deleteCollection(ctx.db, requireId(arg))
      } catch (error) {
        if (!isAppError(error, 'not_found')) throw error
      }
      return menu('已删除。', { newMessage: true })
    case 'account':
      if (arg) select(c, arg)
      return accountList(c, request.group)
    case 'account_delete':
      return accountDelete(c, arg, request.group)
    case 'account_add':
      return accountAdd(c, request)
    case 'usage': {
      const row = ctx.db.$client
        .prepare(
          `SELECT (SELECT coalesce(sum(size), 0) FROM blobs)
             + (SELECT coalesce(sum(content_bytes), 0) FROM revisions)
             + (SELECT coalesce(sum(size), 0) FROM source_responses) AS used`,
        )
        .get() as { used: number | bigint }
      return menu(`已用 ${formatBytes(Number(row.used))}`)
    }
    case 'more':
    case 'more1000':
    case 'page_retry':
      try {
        const job = recordPage(
          ctx,
          requireId(arg),
          request.command,
          request.command === 'page_retry'
            ? String(request.updateId)
            : undefined,
        )
        deliverSubmission(c, request, job.submissionId)
        return {}
      } catch (error) {
        if (isAppError(error, 'no_more_pages'))
          return menu('没有更多帖子了。', { newMessage: true })
        throw error
      }
    case 'collection_stop':
      stopCollection(ctx, requireId(arg))
      deliverSubmission(c, request, arg)
      return menu('已中止。', { newMessage: true })
    case 'batch_retry':
      try {
        const count = retryRefreshBatch(ctx, requireId(arg))
        enqueueDelivery(ctx, {
          kind: 'batch',
          ref: arg,
          chatId: request.chatId,
        })
        return {
          toast: count
            ? `正在重试 ${count} 条失败的帖子。`
            : '没有可重试的帖子。',
          newMessage: true,
        }
      } catch (error) {
        if (isAppError(error, 'batch_running'))
          return { toast: '批量更新仍在进行。', newMessage: true }
        throw error
      }
    default:
      throw new AppError('unsupported')
  }
}

function save(c: CommandContext, request: Request): Reply {
  const { ctx } = c
  if (request.links.length > MAX_LINKS) return menu('每次最多 200 个链接。')
  const seen = new Set<string>()
  const errors: string[] = []
  let count = 0
  for (const link of request.links) {
    let identity: string
    try {
      const { target } = ctx.platforms.resolve(link)
      identity = [
        target.platform,
        target.kind,
        target.objectScope,
        target.externalId,
      ].join('|')
    } catch {
      continue
    }
    if (seen.has(identity)) continue
    seen.add(identity)
    try {
      const job = captureURL(
        ctx,
        link,
        `${request.updateId}:${sha256Hex(identity)}`,
      )
      deliverSubmission(c, request, job.submissionId)
      count++
    } catch (error) {
      errors.push(safeError(error))
    }
  }
  if (errors.length) return { text: errors.join('\n'), newMessage: true }
  if (count === 0 && !request.group)
    return menu('请发送支持的链接，或使用 /help。', { newMessage: true })
  return {}
}

// --- /list -------------------------------------------------------------------

const encode = (value: string) => Buffer.from(value).toString('base64url')

function list(c: CommandContext, arg: string): Reply {
  const { db } = c.ctx
  let before: { at: Date; id: string } | undefined
  let after: { at: Date; id: string } | undefined
  if (arg) {
    const decoded = Buffer.from(arg, 'base64url').toString('utf8')
    const previous = decoded.startsWith('p:')
    const id = previous ? decoded.slice(2) : decoded
    const anchor = db
      .select({ at: library.createdAt })
      .from(library)
      .where(eq(library.collectionId, requireId(id)))
      .get()
    if (!anchor) throw new AppError('invalid_cursor')
    if (previous) after = { at: anchor.at, id }
    else before = { at: anchor.at, id }
  }
  const newer = (p: { at: Date; id: string }) =>
    or(
      gt(library.createdAt, p.at),
      and(eq(library.createdAt, p.at), gt(library.collectionId, p.id)),
    )
  const older = (p: { at: Date; id: string }) =>
    or(
      lt(library.createdAt, p.at),
      and(eq(library.createdAt, p.at), lt(library.collectionId, p.id)),
    )
  let rows = after
    ? db
        .select()
        .from(library)
        .where(newer(after))
        .orderBy(asc(library.createdAt), asc(library.collectionId))
        .limit(LIST_PAGE + 1)
        .all()
    : db
        .select()
        .from(library)
        .where(before ? older(before) : undefined)
        .orderBy(desc(library.createdAt), desc(library.collectionId))
        .limit(LIST_PAGE + 1)
        .all()
  const more = rows.length > LIST_PAGE
  rows = rows.slice(0, LIST_PAGE)
  if (after) rows.reverse()
  if (!rows.length) return { text: '暂无收藏。', keyboard: [] }
  const items = rows.flatMap((row) => {
    try {
      return [getCollection(c.ctx, row.collectionId)]
    } catch {
      return []
    }
  })
  let text = ''
  const entities: MessageEntity[] = []
  const keyboard: Keyboard = []
  for (const [index, item] of items.entries()) {
    if (text) text += '\n\n'
    const label = `${index + 1}. `
    const summary = summaryLine(item.summary || item.text)
    text += label
    entities.push({
      type: 'text_link',
      offset: text.length,
      length: summary.length,
      url: item.url,
    })
    text += summary
    keyboard.push([
      { text: `查看第${index + 1}条`, callback_data: `/show ${item.id}` },
      { text: '原文', url: item.url },
    ])
  }
  const first = rows[0]!.collectionId
  const last = rows.at(-1)!.collectionId
  const hasPrevious = after ? more : !!before
  const hasNext = after ? true : more
  const nav: Keyboard[number] = []
  if (hasPrevious)
    nav.push({
      text: '← 上一页',
      callback_data: `/list ${encode(`p:${first}`)}`,
    })
  if (hasNext)
    nav.push({ text: '下一页 →', callback_data: `/list ${encode(last)}` })
  if (nav.length) keyboard.push(nav)
  return { text, entities, keyboard }
}

// --- Accounts ------------------------------------------------------------------

function select(c: CommandContext, arg: string): void {
  const { ctx } = c
  if (arg === 'public' || arg.startsWith('public:')) {
    let platform = arg.slice('public:'.length)
    if (arg === 'public') {
      const all = ctx.platforms.all()
      if (all.length !== 1) throw new AppError('unsupported')
      platform = all[0]!.description.adapterId
    }
    selectAccount(ctx, platform, '')
    return
  }
  const connection = ctx.db
    .select({ adapterId: connections.adapterId })
    .from(connections)
    .where(eq(connections.id, requireId(arg)))
    .get()
  if (!connection) throw new AppError('not_found')
  selectAccount(ctx, connection.adapterId, arg)
}

function accountList(c: CommandContext, group: boolean): Reply {
  const { platforms, accounts } = listAccounts(c.ctx)
  let text = '选择采集来源。'
  const keyboard: Keyboard = []
  for (const platform of platforms)
    if (!platform.public && !platform.selected)
      text += `\n${platform.name} 需要添加并选择自己的账号凭据后才能采集。`
  for (const platform of platforms)
    if (platform.public)
      keyboard.push([
        {
          text: `${platform.selected ? '' : '✓ '}${platform.name} · 公共来源`,
          callback_data: `/account public:${platform.id}`,
        },
      ])
  for (const account of accounts) {
    const label =
      account.username && account.name
        ? `@${account.username} · ${account.name}`
        : account.username
          ? `@${account.username}`
          : account.name
    const row: Keyboard[number] = [
      {
        text: `${account.selected ? '✓ ' : ''}${label}${account.state === 'ready' ? '' : '（需重新授权）'}`,
        callback_data: `/account ${account.id}`,
      },
    ]
    if (!group)
      row.push({ text: '删除', callback_data: `/account_delete ${account.id}` })
    keyboard.push(row)
  }
  const add = webRoute(c.webAppUrl, '添加账号', '/accounts')
  if (!group && add && platforms.some((p) => p.canAdd)) keyboard.push([add])
  return { text, keyboard }
}

function accountDelete(c: CommandContext, arg: string, group: boolean): Reply {
  if (!arg) return accountList(c, group)
  const back = { text: '返回账号列表', callback_data: '/account' }
  if (arg.startsWith('confirm:')) {
    revokeAccount(c.ctx, requireId(arg.slice('confirm:'.length)))
    return { text: '账号已删除。', keyboard: [[back]] }
  }
  const account = c.ctx.db
    .select({ name: connections.name, state: connections.state })
    .from(connections)
    .where(eq(connections.id, requireId(arg)))
    .get()
  if (!account || account.state === 'revoked') throw new AppError('not_found')
  return {
    text: `删除采集账号 ${account.name}？`,
    keyboard: [
      [
        { text: '确认删除', callback_data: `/account_delete confirm:${arg}` },
        { text: '取消', callback_data: '/account' },
      ],
    ],
  }
}

function accountAdd(c: CommandContext, request: Request): Reply {
  const back = [{ text: '返回账号列表', callback_data: '/account' }]
  if (request.group)
    return { text: '在私聊中打开网页添加采集账号。', keyboard: [back] }
  const add = webRoute(c.webAppUrl, '添加账号', '/accounts')
  if (!add) return { text: '未配置网页入口。', keyboard: [back] }
  return {
    text: request.arg
      ? '不要在聊天中发送凭据。在网页中添加采集账号。'
      : '在网页中添加采集账号。',
    keyboard: [[add], back],
  }
}
