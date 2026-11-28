import type { MessageEntity } from 'grammy/types'

/** Length in UTF-16 code units, the unit of Telegram offsets. */
export const units = (text: string): number => text.length

/** Split at code points so no chunk exceeds `limit` UTF-16 units. */
export function chunks(text: string, limit: number): string[] {
  const out: string[] = []
  let current = ''
  for (const char of text) {
    if (current.length + char.length > limit) {
      out.push(current)
      current = ''
    }
    current += char
  }
  if (current || !out.length) out.push(current)
  return out
}

/** The longest prefix within `limit` units that does not split a pair. */
export function prefix(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end)
}

/** Entities of `entities` that fall in [start, start+length), re-based. */
export function clipEntities(
  entities: readonly MessageEntity[],
  start: number,
  length: number,
): MessageEntity[] {
  const end = start + length
  const out: MessageEntity[] = []
  for (const entity of entities) {
    const from = Math.max(entity.offset, start)
    const to = Math.min(entity.offset + entity.length, end)
    if (to > from)
      out.push({ ...entity, offset: from - start, length: to - from })
  }
  return out
}

/** Drop entities that reach outside the text. */
export function validEntities(
  text: string,
  entities: readonly MessageEntity[] = [],
): MessageEntity[] {
  return entities.filter(
    (e) => e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length,
  )
}

const TRIM = /^[<>[\]()，。！,!]+|[<>[\]()，。！,!]+$/g
const WHITESPACE = /\s+/
const SPACES = /\s+/g
const MEDIA_MARKERS = /(?:\[图片\]|\[视频\])+$/

interface Message {
  text?: string
  caption?: string
  entities?: MessageEntity[]
  caption_entities?: MessageEntity[]
  reply_to_message?: Message
}

/**
 * Links in a message: hidden links, link entities and bare http(s) words,
 * from the text and then the caption, de-duplicated in order.
 */
export function messageLinks(message: Message): string[] {
  const found: string[] = []
  for (const [text, entities] of [
    [message.text, message.entities],
    [message.caption, message.caption_entities],
  ] as const) {
    if (!text) continue
    for (const entity of entities ?? []) {
      if (entity.type === 'text_link') found.push(entity.url)
      else if (
        entity.type === 'url' &&
        entity.offset >= 0 &&
        entity.offset + entity.length <= text.length
      )
        found.push(text.slice(entity.offset, entity.offset + entity.length))
    }
    for (const word of text.split(WHITESPACE)) {
      const trimmed = word.replaceAll(TRIM, '')
      if (trimmed.startsWith('https://') || trimmed.startsWith('http://'))
        found.push(trimmed)
    }
  }
  return [...new Set(found)]
}

/**
 * Links of a message followed by those of the message it replies to, once
 * each. A partial `quote` doesn't matter: the full replied message is used.
 */
export function threadLinks(message: Message): string[] {
  return [
    ...new Set([
      ...messageLinks(message),
      ...(message.reply_to_message
        ? messageLinks(message.reply_to_message)
        : []),
    ]),
  ]
}

/**
 * Whether a group message addresses the bot by an @mention or a
 * `/command@bot` entity, and its text with the mention blanked out.
 */
export function addressedText(
  message: Message,
  username: string,
): { addressed: boolean; text: string } {
  const bot = `@${username.toLowerCase()}`
  let addressed = false
  let text = message.text ?? ''
  for (const [source, entities, isText] of [
    [message.text, message.entities, true],
    [message.caption, message.caption_entities, false],
  ] as const) {
    if (!source) continue
    for (const entity of entities ?? []) {
      if (entity.offset < 0 || entity.offset + entity.length > source.length)
        continue
      const value = source.slice(entity.offset, entity.offset + entity.length)
      if (entity.type === 'mention' && value.toLowerCase() === bot) {
        addressed = true
        if (isText)
          text =
            text.slice(0, entity.offset) +
            ' '.repeat(entity.length) +
            text.slice(entity.offset + entity.length)
      } else if (entity.type === 'bot_command') {
        const at = value.indexOf('@')
        if (at > 0 && value.slice(at).toLowerCase() === bot) addressed = true
      }
    }
  }
  return { addressed, text: text.trim() }
}

/** Collapse whitespace, then cut to `max` code points keeping media markers. */
export function summaryLine(value: string, max = 100): string {
  const text = value.replaceAll(SPACES, ' ').trim()
  const chars = [...text]
  if (chars.length <= max) return text
  const markers = MEDIA_MARKERS.exec(text)?.[0] ?? ''
  const markerLength = [...markers].length
  if (markers && markerLength < max - 1)
    return `${chars.slice(0, max - markerLength - 1).join('')}…${markers}`
  return `${chars.slice(0, max - 1).join('')}…`
}

export function formatBytes(bytes: number): string {
  const gib = 1024 ** 3
  return bytes >= gib
    ? `${(bytes / gib).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
