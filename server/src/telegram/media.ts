import { and, eq } from 'drizzle-orm'
import { GrammyError, InputFile, type Api } from 'grammy'
import { telegramMedia } from '#db/schema.ts'
import type { BlobStore } from '#blob/store.ts'
import type { Database } from '#db/client.ts'
import type { AssetView } from '#library/views.ts'
import type { InlineKeyboardMarkup, Message, MessageEntity } from 'grammy/types'

type Representation = 'photo' | 'video' | 'document'

export interface MediaSender {
  api: Api
  db: Database
  blobs: BlobStore
  botId: string
}

export interface Target {
  chatId: string
  replyTo?: number
}

const EXTENSIONS: Record<string, string> = {
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'image/png': '.png',
  'image/webp': '.webp',
}

function representation(asset: AssetView): Representation {
  if (asset.mime === 'video/mp4') return 'video'
  if (asset.mime === 'video/webm') return 'document'
  return 'photo'
}

const INVALID_FILE_ID = [
  'wrong file identifier',
  'wrong remote file identifier',
  'file_reference_expired',
  'file reference expired',
  'invalid file_id',
  'file_id not found',
]

function isInvalidFileId(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    INVALID_FILE_ID.some((text) =>
      error.description.toLowerCase().includes(text),
    )
  )
}

const isBadRequest = (error: unknown) =>
  error instanceof GrammyError && error.error_code === 400

/**
 * A video's size for Telegram, which otherwise shows it square until it
 * plays: what the platform said of it (or its thumbnail's, in the same
 * proportions). Undefined when unknown or past Telegram's limits.
 */
export function videoSize(
  asset: Pick<AssetView, 'width' | 'height'>,
): { width: number; height: number } | undefined {
  const { width, height } = asset
  if (!width || !height || width > 65_535 || height > 65_535) return undefined
  return { width, height }
}

export class Media {
  readonly #s: MediaSender

  constructor(sender: MediaSender) {
    this.#s = sender
  }

  #cached(hash: string, kind: Representation): string | undefined {
    return this.#s.db
      .select({ fileId: telegramMedia.fileId })
      .from(telegramMedia)
      .where(
        and(
          eq(telegramMedia.botId, this.#s.botId),
          eq(telegramMedia.hash, hash),
          eq(telegramMedia.representation, kind),
        ),
      )
      .get()?.fileId
  }

  #remember(hash: string, kind: Representation, fileId: string): void {
    this.#s.db
      .insert(telegramMedia)
      .values({ botId: this.#s.botId, hash, representation: kind, fileId })
      .onConflictDoUpdate({
        target: [
          telegramMedia.botId,
          telegramMedia.hash,
          telegramMedia.representation,
        ],
        set: { fileId },
      })
      .run()
  }

  #forget(hash: string, kind: Representation, fileId: string): void {
    this.#s.db
      .delete(telegramMedia)
      .where(
        and(
          eq(telegramMedia.botId, this.#s.botId),
          eq(telegramMedia.hash, hash),
          eq(telegramMedia.representation, kind),
          eq(telegramMedia.fileId, fileId),
        ),
      )
      .run()
  }

  #file(asset: AssetView): InputFile {
    const blobs = this.#s.blobs
    const name = `${asset.sha256}${EXTENSIONS[asset.mime ?? ''] ?? '.jpg'}`
    return new InputFile(() => blobs.read(asset.sha256!), name)
  }

  /** One media message input, from the cache or as an upload. */
  #input(asset: AssetView, kind: Representation, useCache: boolean) {
    const cached = useCache ? this.#cached(asset.sha256!, kind) : undefined
    const media = cached ?? this.#file(asset)
    const spoiler = asset.sensitive && kind !== 'document'
    if (kind === 'video') {
      const size = cached ? undefined : videoSize(asset)
      return {
        type: 'video' as const,
        media,
        supports_streaming: true,
        ...size,
        ...(spoiler ? { has_spoiler: true } : {}),
        cached,
      }
    }
    return {
      type: kind,
      media,
      ...(spoiler ? { has_spoiler: true } : {}),
      cached,
    }
  }

  #learn(assets: AssetView[], kinds: Representation[], messages: Message[]) {
    if (messages.length !== assets.length) return
    for (const [i, message] of messages.entries()) {
      const fileId =
        message.video?.file_id ??
        message.document?.file_id ??
        message.photo?.toSorted(
          (a, b) => b.width * b.height - a.width * a.height,
        )[0]?.file_id
      if (fileId) this.#remember(assets[i]!.sha256!, kinds[i]!, fileId)
    }
  }

  async #sendOne(
    target: Target,
    asset: AssetView,
    kind: Representation,
    caption: { text: string; entities: MessageEntity[] },
    keyboard: InlineKeyboardMarkup | undefined,
    useCache: boolean,
  ): Promise<Message> {
    const input = this.#input(asset, kind, useCache)
    const common = {
      caption: caption.text || undefined,
      caption_entities: caption.text ? caption.entities : undefined,
      reply_markup: keyboard,
      ...(target.replyTo
        ? { reply_parameters: { message_id: target.replyTo } }
        : {}),
      ...('has_spoiler' in input ? { has_spoiler: true } : {}),
    }
    const api = this.#s.api
    try {
      const message =
        kind === 'video'
          ? await api.sendVideo(target.chatId, input.media, {
              ...common,
              supports_streaming: true,
              ...(input.type === 'video' && input.width
                ? { width: input.width, height: input.height }
                : {}),
            })
          : kind === 'photo'
            ? await api.sendPhoto(target.chatId, input.media, common)
            : await api.sendDocument(target.chatId, input.media, common)
      this.#learn([asset], [kind], [message])
      return message
    } catch (error) {
      if (input.cached && isInvalidFileId(error)) {
        this.#forget(asset.sha256!, kind, input.cached)
        return this.#sendOne(target, asset, kind, caption, keyboard, false)
      }
      throw error
    }
  }

  /** Send one media item; photos and videos Telegram refuses go as files. */
  async sendItem(
    target: Target,
    asset: AssetView,
    caption: { text: string; entities: MessageEntity[] },
  ): Promise<Message> {
    const kind = representation(asset)
    try {
      return await this.#sendOne(target, asset, kind, caption, undefined, true)
    } catch (error) {
      if (kind !== 'document' && isBadRequest(error))
        return this.#sendOne(
          target,
          asset,
          'document',
          caption,
          undefined,
          true,
        )
      throw error
    }
  }

  async #sendGroup(
    target: Target,
    assets: AssetView[],
    kinds: Representation[],
    useCache: boolean,
  ): Promise<Message[]> {
    const inputs = assets.map((asset, i) =>
      this.#input(asset, kinds[i]!, useCache),
    )
    try {
      const messages = await this.#s.api.sendMediaGroup(
        target.chatId,
        inputs.map(({ cached: _, ...media }) => media) as Parameters<
          Api['sendMediaGroup']
        >[1],
        target.replyTo
          ? { reply_parameters: { message_id: target.replyTo } }
          : {},
      )
      this.#learn(assets, kinds, messages)
      return messages
    } catch (error) {
      if (useCache && inputs.some((i) => i.cached) && isInvalidFileId(error)) {
        for (const [i, input] of inputs.entries())
          if (input.cached)
            this.#forget(assets[i]!.sha256!, kinds[i]!, input.cached)
        return this.#sendGroup(target, assets, kinds, false)
      }
      throw error
    }
  }

  /** Send an album; one Telegram refuses goes again as files. */
  async sendAlbum(target: Target, assets: AssetView[]): Promise<Message[]> {
    const webm = assets.some((a) => a.mime === 'video/webm')
    const kinds = assets.map((a) => (webm ? 'document' : representation(a)))
    try {
      return await this.#sendGroup(target, assets, kinds, true)
    } catch (error) {
      if (!webm && isBadRequest(error))
        return this.#sendGroup(
          target,
          assets,
          assets.map(() => 'document' as const),
          true,
        )
      throw error
    }
  }
}
