import { chunks, clipEntities, prefix } from './text.ts'
import type { AssetView } from '#library/views.ts'
import type { MessageEntity } from 'grammy/types'

export const MAX_TELEGRAM_FILE = 50_000_000
const CAPTION = 1024
const TEXT = 3500
const ALBUM = 10

export type Part =
  | {
      kind: 'media'
      assets: AssetView[]
      caption: string
      entities: MessageEntity[]
    }
  | { kind: 'buttons' }
  | { kind: 'text'; text: string; entities: MessageEntity[] }

function textParts(text: string, entities: MessageEntity[], from = 0): Part[] {
  const rest = text.slice(from)
  if (!rest) return []
  const out: Part[] = []
  let offset = from
  for (const chunk of chunks(rest, TEXT)) {
    out.push({
      kind: 'text',
      text: chunk,
      entities: clipEntities(entities, offset, chunk.length),
    })
    offset += chunk.length
  }
  return out
}

const isWebm = (asset: AssetView) => asset.mime === 'video/webm'

/**
 * How a collection message goes out: media first (one item carries the
 * start of the text as its caption; albums carry none), then the text.
 */
export function deliveryParts(
  baseText: string,
  entities: MessageEntity[],
  assets: readonly AssetView[],
): Part[] {
  let text = baseText
  const sendable: AssetView[] = []
  for (const asset of assets) {
    if (asset.state !== 'ready') continue
    if (asset.size > MAX_TELEGRAM_FILE) {
      text += '\n\n文件超过 Telegram 大小限制，请在网页查看。'
      continue
    }
    sendable.push(asset)
  }
  if (sendable.length === 1) {
    const caption = prefix(text, CAPTION)
    return [
      {
        kind: 'media',
        assets: sendable,
        caption,
        entities: clipEntities(entities, 0, caption.length),
      },
      { kind: 'buttons' },
      ...textParts(text, entities, caption.length),
    ]
  }
  const parts: Part[] = []
  let album: AssetView[] = []
  for (const asset of sendable) {
    if (
      album.length === ALBUM ||
      (album.length && isWebm(album[0]!) !== isWebm(asset))
    ) {
      parts.push({ kind: 'media', assets: album, caption: '', entities: [] })
      album = []
    }
    album.push(asset)
  }
  if (album.length)
    parts.push({ kind: 'media', assets: album, caption: '', entities: [] })
  return [...parts, ...textParts(text, entities)]
}
