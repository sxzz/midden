import type { CollectionView, EntityView } from '#library/views.ts'
import type { InlineKeyboardButton, MessageEntity } from 'grammy/types'

export type Keyboard = InlineKeyboardButton[][]

export interface Rendered {
  text: string
  entities: MessageEntity[]
  keyboard?: Keyboard
}

// --- Commands --------------------------------------------------------------

export interface CommandInfo {
  name: string
  description: string
  privateOnly: boolean
}

export const COMMANDS: CommandInfo[] = [
  { name: 'start', description: '开始使用', privateOnly: true },
  { name: 'save', description: '保存帖子', privateOnly: false },
  { name: 'list', description: '查看收藏列表', privateOnly: true },
  { name: 'show', description: '查看指定收藏', privateOnly: false },
  { name: 'status', description: '查看采集状态', privateOnly: false },
  { name: 'retry', description: '使用当前账号重试', privateOnly: false },
  { name: 'refresh', description: '重新抓取帖子', privateOnly: false },
  { name: 'delete', description: '删除', privateOnly: false },
  { name: 'account_delete', description: '删除采集账号', privateOnly: true },
  { name: 'account', description: '选择采集账号', privateOnly: false },
  { name: 'usage', description: '查看存储用量', privateOnly: false },
  { name: 'help', description: '查看使用帮助', privateOnly: false },
]

export const MENU_BUTTONS: Keyboard = [
  [
    { text: '收藏列表', callback_data: '/list' },
    { text: '存储用量', callback_data: '/usage' },
  ],
]

export function helpText(group: boolean): string {
  let text = '发送支持的平台链接保存内容（每次最多 200 个）。'
  for (const command of COMMANDS)
    if (!group || !command.privateOnly)
      text += `\n/${command.name} — ${command.description}`
  return text
}

const PRIVATE_DATA = /^\/(?:start|list|account_delete)(?:\s|$)/

/** Telegram allows no web_app buttons in groups; private commands go too. */
export function groupKeyboard(
  keyboard: Keyboard | undefined,
): Keyboard | undefined {
  if (!keyboard) return keyboard
  return keyboard
    .map((row) =>
      row.filter(
        (button) =>
          !('web_app' in button) &&
          (!('callback_data' in button) ||
            !PRIVATE_DATA.test(button.callback_data ?? '')),
      ),
    )
    .filter((row) => row.length > 0)
}

/** A web_app button to a route of the Mini App, if it is served over HTTPS. */
export function webRoute(
  webAppUrl: string | undefined,
  text: string,
  route: string,
): InlineKeyboardButton | undefined {
  if (!webAppUrl) return undefined
  let url: URL
  try {
    url = new URL(webAppUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || !url.host) return undefined
  url.hash = route
  return { text, web_app: { url: url.href } }
}

// --- Texts -----------------------------------------------------------------

export function jobState(state: string): string {
  switch (state) {
    case 'queued':
      return '正在采集'
    case 'downloading':
      return '正在保存媒体'
    case 'complete':
      return '收藏完成'
    case 'partial':
      return '已收藏，部分资源缺失'
    case 'failed':
      return '收藏失败'
    default:
      return state
  }
}

const INSTAGRAM_LOGIN =
  'Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试。'
const INSTAGRAM_CHECK =
  'Instagram 要求登录验证或账号无权访问，请检查账号后重试。'
const REASONS: Record<string, string> = {
  'storage quota exceeded': '存储空间不足',
  'account cannot access this post': '采集账号无权访问该帖子',
  'account is suspended': '账号已被封禁，解封后可重新抓取',
  'profile not found': '账号不存在或已改名',
  'post not found or deleted': '帖子不存在或已删除',
  'provider cannot access this post': '无法获取该帖子',
  'provider cannot access this profile': '无法获取该账号资料',
  'account required; add and select your own credentials':
    '此平台需要账号，请先在采集账号中添加并选择一个账号。',
  'Instagram requires an account; select an Instagram account and retry':
    INSTAGRAM_LOGIN,
  'Instagram requires login': INSTAGRAM_LOGIN,
  'Instagram session expired; authorize again':
    'Instagram 登录已失效，请重新添加账号授权。',
  'Instagram rate limited the request': 'Instagram 请求过于频繁，请稍后重试。',
  'Instagram access denied or browser verification required': INSTAGRAM_CHECK,
  'Instagram requires browser verification': INSTAGRAM_CHECK,
  'Instagram redirected to login or verification': INSTAGRAM_CHECK,
  'Instagram requires login, verification, or a later retry': INSTAGRAM_CHECK,
  'Instagram content not found or inaccessible':
    'Instagram 内容不存在或当前账号无权访问。',
  'Instagram temporarily unavailable': 'Instagram 暂时不可用，请稍后重试。',
  'provider temporarily unavailable': '来源平台暂时不可用，请稍后重试。',
  'account request signing unavailable': '采集账号请求签名不可用',
  'context deadline exceeded': '请求超时',
  'job exhausted retries or was interrupted': '任务重试次数已用尽或执行被中断',
  'operation failed; retry or inspect service health': '服务内部错误',
  'resource omitted: unsupported type or resource limit':
    '部分资源类型不支持或资源数量超过限制',
}

/** A stored failure reason in the words users read; unknown ones as is. */
export function failureReason(reason: string): string {
  const trimmed = reason.trim()
  return REASONS[trimmed] ?? trimmed
}

// --- Collections -----------------------------------------------------------

const PROFILE_TYPES = new Set(['x.profile', 'instagram.profile'])
const INSTAGRAM_HANDLE = /^\w(?:[\w.]{0,28}\w)?$/
const X_HANDLE = /^\w{1,15}$/
const NUMERIC = /^\d+$/

function root(collection: CollectionView): EntityView | undefined {
  return collection.graph?.entities.find(
    (e) => e.key === collection.graph!.root,
  )
}

export function isProfile(collection: CollectionView): boolean {
  const entity = root(collection)
  return !!entity && PROFILE_TYPES.has(entity.type)
}

function data(entity: EntityView | undefined): Record<string, unknown> {
  return (entity?.data ?? {}) as Record<string, unknown>
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** The profile a collection is by (posts) or about (profiles). */
export function authorEntity(
  collection: CollectionView,
): EntityView | undefined {
  const graph = collection.graph
  if (!graph) return undefined
  const relation = graph.relations.find(
    (r) => r.source === graph.root && r.type === 'authored_by',
  )
  return relation
    ? graph.entities.find((e) => e.key === relation.target)
    : root(collection)
}

export function profileURL(entity: EntityView | undefined): string | undefined {
  if (!entity) return undefined
  const username = text(data(entity).username)
  if (entity.type === 'instagram.profile')
    return INSTAGRAM_HANDLE.test(username) && !username.includes('..')
      ? `https://www.instagram.com/${username}/`
      : undefined
  if (entity.type === 'x.profile') {
    if (X_HANDLE.test(username)) return `https://x.com/${username}`
    if (NUMERIC.test(entity.external_id))
      return `https://x.com/i/user/${entity.external_id}`
  }
  return undefined
}

function profileText(collection: CollectionView): Rendered {
  const entity = root(collection)
  const values = data(entity)
  const name =
    text(values.name).trim() || collection.author_name?.trim() || '未知作者'
  let body = name
  const username = text(values.username)
  if (username) body += `\n@${username}`
  const bio = text(
    (values.metadata as Record<string, unknown> | undefined)?.description,
  ).trim()
  if (bio) body += `\n\n${bio}`
  const url = profileURL(entity)
  return {
    text: body,
    entities: url
      ? [{ type: 'text_link', offset: 0, length: name.length, url }]
      : [],
  }
}

export interface CollectionMessage extends Rendered {
  keyboard: Keyboard
}

/** The final message for a saved collection, before splitting. */
export function collectionMessage(
  collection: CollectionView,
  state: string,
  options: { webAppUrl?: string; reasons?: string[] } = {},
): CollectionMessage {
  const blocks: string[] = []
  let entities: MessageEntity[] = []
  if (isProfile(collection)) {
    const profile = profileText(collection)
    blocks.push(profile.text)
    entities = profile.entities
  } else {
    const author = collection.author_name?.trim() || '未知作者'
    const body = collection.text.trim()
    blocks.push(collection.id, body ? `${author}：\n${body}` : author)
    entities.push({ type: 'code', offset: 0, length: collection.id.length })
    const url = profileURL(authorEntity(collection))
    const authorAt = collection.id.length + 2
    if (url)
      entities.push({
        type: 'text_link',
        offset: authorAt,
        length: author.length,
        url,
      })
    if (body)
      entities.push({
        type: 'blockquote',
        offset: authorAt + author.length + 2,
        length: body.length,
      })
  }
  if (state === 'partial') blocks.push('部分内容未保存')
  for (const asset of collection.assets)
    if (asset.alt_text)
      blocks.push(`媒体 ${asset.position + 1} 描述：${asset.alt_text}`)
  const reasons = new Set<string>()
  for (const reason of [
    ...collection.warnings,
    ...collection.assets
      .filter((a) => a.state === 'failed' && a.error)
      .map((a) => a.error!),
    ...(options.reasons ?? []),
  ])
    reasons.add(failureReason(reason))
  for (const reason of reasons) blocks.push(`未完整保存原因：${reason}`)

  const source = isProfile(collection)
    ? collection.url.includes('instagram.com')
      ? '在 Instagram 查看主页'
      : '在 X 查看主页'
    : '原帖'
  const keyboard: Keyboard = [
    [
      { text: source, url: collection.url },
      { text: '重新抓取', callback_data: `/refresh ${collection.id}` },
    ],
    [{ text: '删除', callback_data: `/delete ${collection.id}` }],
    [{ text: '收藏列表', callback_data: '/list' }],
  ]
  const open = webRoute(
    options.webAppUrl,
    '在小程序中打开',
    `/collection/${collection.id}`,
  )
  if (open) keyboard.push([open])
  return { text: blocks.join('\n\n'), entities, keyboard }
}

/** For a profile, Telegram shows only its avatar. */
export function messageAssets(collection: CollectionView) {
  if (!isProfile(collection)) return collection.assets
  const avatar = root(collection)?.assets?.find((a) => a.purpose === 'avatar')
  return avatar ? [avatar] : []
}

// --- Progress --------------------------------------------------------------

export interface ProgressInput {
  submissionId: string
  collectionId: string
  url: string
  input: string
  rootState: string
  rootError: string
  total: number
  complete: number
  partial: number
  failed: number
  done: boolean
  stopped: boolean
  next: string
  maxBatch: number
  pageError: boolean
  reasons: { reason: string; count: number }[]
}

const MAX_REASONS = 8
const REASON_LENGTH = 180

function cut(value: string, max: number): string {
  const chars = [...value]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

export function hostLabel(url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {}
  return ['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(
    host,
  )
    ? '在 Instagram 查看主页'
    : '在 X 查看主页'
}

/** The message tracking a profile (timeline) capture and its members. */
export function progressMessage(
  p: ProgressInput,
  options: { webAppUrl?: string; group: boolean },
): Rendered {
  let body: string
  if (p.rootState === 'failed') {
    body = `帖子列表获取失败\n输入：${p.input}\n${failureReason(p.rootError)}`
  } else {
    const heading = p.stopped ? '采集已中止' : p.done ? '采集完成' : '正在采集…'
    const running = Math.max(0, p.total - p.complete - p.partial - p.failed)
    body = `${heading}\n${p.url}\n\n本次 ${p.total} 项：已保存 ${p.complete} · 内容不完整 ${p.partial} · 失败 ${p.failed} · 进行中 ${running}`
  }
  if (p.pageError) body += '\n部分页面获取失败。'
  if (p.reasons.length) {
    body += '\n\n未完整保存原因：'
    for (const { reason, count } of p.reasons.slice(0, MAX_REASONS))
      body += `\n• ${cut(failureReason(reason), REASON_LENGTH)}（${count} 条）`
    if (p.reasons.length > MAX_REASONS)
      body += `\n另有 ${p.reasons.length - MAX_REASONS} 类原因。`
  }
  const keyboard: Keyboard = [[{ text: hostLabel(p.url), url: p.url }]]
  const finished = p.done && !p.stopped
  if (finished && p.next) {
    keyboard.push([
      { text: '抓取更多', callback_data: `/more ${p.submissionId}` },
    ])
    if (p.maxBatch >= 1000)
      keyboard.push([
        { text: '抓取 1000 条', callback_data: `/more1000 ${p.submissionId}` },
      ])
  }
  if (
    finished &&
    (p.pageError || p.rootState === 'failed' || p.rootState === 'partial')
  )
    keyboard.push([
      { text: '重试本页', callback_data: `/page_retry ${p.submissionId}` },
    ])
  if (!p.done && !p.stopped)
    keyboard.push([
      { text: '中止', callback_data: `/collection_stop ${p.submissionId}` },
    ])
  keyboard.push(
    [{ text: '查看已保存资料', callback_data: `/show ${p.collectionId}` }],
    [{ text: '收藏列表', callback_data: '/list' }],
  )
  if (!options.group) {
    const progress = webRoute(
      options.webAppUrl,
      '在小程序查看进度',
      `/captures/${p.submissionId}`,
    )
    const open = webRoute(
      options.webAppUrl,
      '在小程序中打开',
      `/collection/${p.collectionId}`,
    )
    if (progress) keyboard.push([progress])
    if (open) keyboard.push([open])
  }
  return { text: body, entities: [], keyboard }
}
