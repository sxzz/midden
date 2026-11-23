import path from 'node:path'
import { Bot, type Context } from 'grammy'
import { handle, type Reply, type Request } from './commands.ts'
import {
  DeliveryWorker,
  editText,
  enqueueDelivery,
  isDeliveryMessage,
  sendText,
} from './delivery.ts'
import { Media } from './media.ts'
import { COMMANDS, groupKeyboard } from './presentation.ts'
import { addressedText, chunks, clipEntities, messageLinks } from './text.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { Message } from 'grammy/types'

export interface BotOptions {
  ctx: AccountsContext
  token: string
  owner: string
  webAppUrl?: string
  version: string
  ffmpeg: string
}

const TEXT_LIMIT = 3500
const FIELDS = /\s+/
const PLATFORM_PREFIX = /^@\S+\s*/

/** Whether Telegram says this update comes from the owner, in a usable chat. */
function fromOwner(
  message: Message | undefined,
  from: { id: number; is_bot: boolean } | undefined,
  owner: string,
): boolean {
  if (!message || !from || from.is_bot || from.id <= 0) return false
  if (String(from.id) !== owner) return false
  if (message.sender_chat) return false
  const { chat } = message
  if (chat.type === 'private') return chat.id === from.id
  return (chat.type === 'group' || chat.type === 'supergroup') && chat.id < 0
}

function validLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) && !!url.host && !url.username
    )
  } catch {
    return false
  }
}

export interface RunningBot {
  stop: () => Promise<void>
  /** Follow a refresh batch in the owner's private chat. */
  followBatch: (batchId: string) => void
}

export async function startBot(options: BotOptions): Promise<RunningBot> {
  const { ctx, owner } = options
  const bot = new Bot(options.token)
  await bot.init()
  const username = bot.botInfo.username ?? ''
  const media = new Media({
    api: bot.api,
    db: ctx.db,
    blobs: ctx.blobs,
    botId: String(bot.botInfo.id),
    // ffprobe ships beside ffmpeg; a bare name is looked up on PATH.
    ffprobe: options.ffmpeg.includes(path.sep)
      ? path.join(path.dirname(options.ffmpeg), 'ffprobe')
      : 'ffprobe',
  })
  const worker = new DeliveryWorker({
    ctx,
    api: bot.api,
    media,
    webAppUrl: options.webAppUrl,
  })

  await bot.api.setMyCommands(
    COMMANDS.map((c) => ({ command: c.name, description: c.description })),
  )
  await bot.api.setMyCommands(
    COMMANDS.filter((c) => !c.privateOnly).map((c) => ({
      command: c.name,
      description: c.description,
    })),
    { scope: { type: 'all_group_chats' } },
  )
  const menuButton = options.webAppUrl
    ? ({
        type: 'web_app',
        text: '打开',
        web_app: { url: options.webAppUrl },
      } as const)
    : ({ type: 'commands' } as const)
  await bot.api.setChatMenuButton({ menu_button: menuButton })
  // A menu button set in BotFather outranks the default one; the owner's own
  // chat setting outranks both.
  await bot.api.setChatMenuButton({
    chat_id: Number(owner),
    menu_button: menuButton,
  })

  const commandContext = {
    ctx,
    webAppUrl: options.webAppUrl,
    version: options.version,
  }

  async function reply(
    chatId: string,
    group: boolean,
    trigger: number,
    editable: number | undefined,
    result: Reply,
  ) {
    if (!result.text) return
    const keyboard = group ? groupKeyboard(result.keyboard) : result.keyboard
    const target = { chatId, replyTo: group ? trigger : undefined }
    let offset = 0
    for (const [index, part] of chunks(result.text, TEXT_LIMIT).entries()) {
      const rendered = {
        text: part,
        entities: clipEntities(result.entities ?? [], offset, part.length),
        keyboard: index === 0 ? keyboard : undefined,
      }
      offset += part.length
      if (index === 0 && editable !== undefined)
        await editText(bot.api, target, editable, rendered)
      else await sendText(bot.api, target, rendered)
    }
  }

  bot.on('message', async (update: Context) => {
    const message = update.message!
    if (!fromOwner(message, update.from, owner)) return
    const group = message.chat.type !== 'private'
    let text = message.text ?? ''
    if (group) {
      const addressed = addressedText(message, username)
      if (!addressed.addressed) return
      text = addressed.text
    }
    const [first = '', ...rest] = text.trim().split(FIELDS)
    let command = 'save'
    let arg = ''
    if (first.startsWith('/')) {
      const [name = '', suffix] = first.slice(1).split('@', 2)
      if (group && suffix && suffix.toLowerCase() !== username.toLowerCase())
        return
      command = name
      arg = rest.join(' ').trim()
    }
    const links = messageLinks(message).filter(validLink)
    if (
      group &&
      command === 'save' &&
      !first.startsWith('/') &&
      links.length === 0
    )
      return
    if (
      group &&
      first.startsWith('/') &&
      COMMANDS.every((c) => c.name !== command)
    )
      return
    if (command === 'account_add') {
      // A pasted credential never stays in the chat or reaches anything else.
      const credential = arg.replace(PLATFORM_PREFIX, '')
      arg = credential ? 'pasted' : ''
      if (credential)
        await bot.api
          .deleteMessage(message.chat.id, message.message_id)
          .catch(() => {})
    }
    const request: Request = {
      command,
      arg,
      group,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      updateId: update.update.update_id,
      links: command === 'save' ? links : [],
    }
    await reply(
      request.chatId,
      group,
      message.message_id,
      undefined,
      handle(commandContext, request),
    )
  })

  bot.on('callback_query:data', async (update) => {
    const query = update.callbackQuery
    const message = query.message as Message | undefined
    if (!fromOwner(message, query.from, owner)) {
      await update.answerCallbackQuery().catch(() => {})
      return
    }
    const group = message!.chat.type !== 'private'
    const [first = '', ...rest] = query.data.trim().split(FIELDS)
    const request: Request = {
      command: first.startsWith('/') ? first.slice(1) : 'help',
      arg: rest.join(' ').trim(),
      group,
      chatId: String(message!.chat.id),
      messageId: message!.message_id,
      updateId: update.update.update_id,
      links: [],
    }
    if (request.command === 'start' || query.data.length > 64) {
      request.command = 'help'
      request.arg = ''
    }
    let result: Reply = {}
    try {
      result = handle(commandContext, request)
    } finally {
      await update
        .answerCallbackQuery(result.toast ? { text: result.toast } : {})
        .catch(() => {})
    }
    const editable =
      !group &&
      !result.newMessage &&
      !isDeliveryMessage(ctx, request.chatId, message!.message_id)
        ? message!.message_id
        : undefined
    await reply(request.chatId, group, message!.message_id, editable, result)
  })

  bot.catch((error) =>
    ctx.logger.error({ err: error.error }, 'telegram update failed'),
  )
  bot
    .start({ allowed_updates: ['message', 'callback_query'] })
    .catch((error) =>
      ctx.logger.error({ err: error }, 'telegram polling stopped'),
    )
  worker.start()
  return {
    stop: async () => {
      worker.stop()
      await bot.stop()
    },
    followBatch: (batchId) =>
      enqueueDelivery(ctx, { kind: 'batch', ref: batchId, chatId: owner }),
  }
}
