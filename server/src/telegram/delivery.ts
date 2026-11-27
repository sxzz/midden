import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import { GrammyError, type Api } from 'grammy'
import { loadRequest } from '#capture/identity.ts'
import {
  captureWaits,
  collectionProgress,
  collectionReasons,
  rateLimitedMembers,
} from '#capture/records.ts'
import { updateRecord } from '#capture/updates.ts'
import { newId } from '#db/id.ts'
import {
  captures,
  collections,
  submissions,
  telegramDeliveries,
  updates,
} from '#db/schema.ts'
import { readJobControl } from '#jobs/control.ts'
import { getCaptureCollection, getCollection } from '#library/read.ts'
import { deliveryParts, type Part } from './parts.ts'
import {
  collectionMessage,
  groupKeyboard,
  messageAssets,
  progressMessage,
  waitLabel,
  webRoute,
  type Keyboard,
  type Rendered,
} from './presentation.ts'
import { validEntities } from './text.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Media, Target } from './media.ts'
import type { MessageEntity } from 'grammy/types'

const POLL = 5000
const MIN_BACKOFF = 5000
const MAX_BACKOFF = 600_000

type Delivery = typeof telegramDeliveries.$inferSelect

export interface Deliverer {
  ctx: CaptureContext
  api: Api
  media: Media
  webAppUrl?: string
  now?: () => number
}

/** Queue a message to the owner; one per submission or collection. */
export function enqueueDelivery(
  ctx: CaptureContext,
  input: {
    kind: Delivery['kind']
    ref: string
    chatId: string
    group?: boolean
    replyTo?: number
  },
): void {
  const existing = ctx.db
    .select({ id: telegramDeliveries.id })
    .from(telegramDeliveries)
    .where(
      and(
        eq(telegramDeliveries.kind, input.kind),
        eq(telegramDeliveries.ref, input.ref),
        eq(telegramDeliveries.chatId, input.chatId),
      ),
    )
    .get()
  if (existing && input.kind !== 'show') {
    // Reopen it, e.g. a stopped collection.
    ctx.db
      .update(telegramDeliveries)
      .set({ state: 'pending', nextAt: new Date(ctx.now?.() ?? Date.now()) })
      .where(eq(telegramDeliveries.id, existing.id))
      .run()
    return
  }
  ctx.db
    .insert(telegramDeliveries)
    .values({
      id: newId(),
      kind: input.kind,
      ref: input.ref,
      chatId: input.chatId,
      group: input.group ?? false,
      replyTo: input.replyTo,
      nextAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .run()
}

/** Message ids the bot keeps editing; replies never overwrite them. */
export function isDeliveryMessage(
  ctx: CaptureContext,
  chatId: string,
  messageId: number,
): boolean {
  return !!ctx.db
    .select({ id: telegramDeliveries.id })
    .from(telegramDeliveries)
    .where(
      and(
        eq(telegramDeliveries.chatId, chatId),
        eq(telegramDeliveries.messageId, messageId),
      ),
    )
    .get()
}

const description = (error: unknown) =>
  error instanceof GrammyError ? error.description.toLowerCase() : ''

/** Send text, honoring the reply target; link previews are always off. */
export async function sendText(
  api: Api,
  target: Target,
  rendered: Rendered,
): Promise<number> {
  const message = await api.sendMessage(target.chatId, rendered.text, {
    entities: validEntities(rendered.text, rendered.entities),
    link_preview_options: { is_disabled: true },
    reply_markup: rendered.keyboard
      ? { inline_keyboard: rendered.keyboard }
      : undefined,
    ...(target.replyTo
      ? { reply_parameters: { message_id: target.replyTo } }
      : {}),
  })
  return message.message_id
}

/** Edit a message in place; one that is gone is sent anew. */
export async function editText(
  api: Api,
  target: Target,
  messageId: number,
  rendered: Rendered,
): Promise<number> {
  try {
    await api.editMessageText(target.chatId, messageId, rendered.text, {
      entities: validEntities(rendered.text, rendered.entities),
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: rendered.keyboard ?? [] },
    })
    return messageId
  } catch (error) {
    const text = description(error)
    if (text.includes('message is not modified')) return messageId
    if (
      text.includes('message to edit not found') ||
      text.includes("message can't be edited")
    )
      return sendText(api, target, rendered)
    throw error
  }
}

async function deleteMessage(api: Api, chatId: string, messageId: number) {
  try {
    await api.deleteMessage(chatId, messageId)
  } catch (error) {
    if (!description(error).includes('message to delete not found')) throw error
  }
}

export class DeliveryWorker {
  readonly #d: Deliverer
  #timer: NodeJS.Timeout | undefined
  #running = false
  #stopped = false

  constructor(deliverer: Deliverer) {
    this.#d = deliverer
  }

  #now() {
    return this.#d.now?.() ?? Date.now()
  }

  start(): void {
    this.#stopped = false
    const tick = async () => {
      if (this.#stopped) return
      try {
        await this.runDue()
      } catch (error) {
        // Such as the database being locked: the deliveries wait in it.
        this.#d.ctx.logger.warn(
          { err: error },
          'delivering failed; trying again in a second',
        )
      }
      if (this.#stopped) return
      this.#timer = setTimeout(tick, 1000)
      this.#timer.unref()
    }
    tick().catch(() => {})
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** Process every delivery that is due, one at a time. */
  async runDue(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      for (;;) {
        const due = this.#d.ctx.db
          .select()
          .from(telegramDeliveries)
          .where(
            and(
              eq(telegramDeliveries.state, 'pending'),
              lte(telegramDeliveries.nextAt, new Date(this.#now())),
            ),
          )
          .orderBy(
            asc(telegramDeliveries.nextAt),
            asc(telegramDeliveries.createdAt),
          )
          .limit(1)
          .get()
        if (!due || this.#stopped) return
        await this.#runOne(due)
      }
    } finally {
      this.#running = false
    }
  }

  #update(id: string, values: Partial<Delivery>) {
    this.#d.ctx.db
      .update(telegramDeliveries)
      .set(values)
      .where(eq(telegramDeliveries.id, id))
      .run()
  }

  async #runOne(delivery: Delivery): Promise<void> {
    try {
      const again = await this.#deliver(delivery)
      this.#update(delivery.id, {
        failures: 0,
        ...(again
          ? { nextAt: new Date(this.#now() + POLL) }
          : { state: 'done' }),
      })
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const seconds = Math.max(error.parameters.retry_after ?? 1, 1)
        this.#update(delivery.id, {
          nextAt: new Date(this.#now() + seconds * 1000),
        })
      } else if (
        error instanceof GrammyError &&
        error.error_code >= 400 &&
        error.error_code < 500
      ) {
        this.#d.ctx.logger.warn(
          { err: error, delivery: delivery.id },
          'delivery rejected',
        )
        this.#update(delivery.id, { state: 'failed' })
      } else {
        const delay = Math.min(
          MIN_BACKOFF * 2 ** delivery.failures,
          MAX_BACKOFF,
        )
        this.#d.ctx.logger.warn(
          { err: error, delivery: delivery.id },
          'delivery failed',
        )
        this.#update(delivery.id, {
          failures: delivery.failures + 1,
          nextAt: new Date(this.#now() + delay),
        })
      }
    }
  }

  #target(delivery: Delivery): Target {
    return { chatId: delivery.chatId, replyTo: delivery.replyTo ?? undefined }
  }

  #keyboard(delivery: Delivery, keyboard: Keyboard | undefined) {
    return delivery.group ? groupKeyboard(keyboard) : keyboard
  }

  /** Show or update a single message; returns its id. */
  async #status(delivery: Delivery, rendered: Rendered): Promise<void> {
    const shown = {
      ...rendered,
      keyboard: this.#keyboard(delivery, rendered.keyboard),
    }
    const target = this.#target(delivery)
    const id = delivery.messageId
      ? await editText(this.#d.api, target, delivery.messageId, shown)
      : await sendText(this.#d.api, target, shown)
    if (id !== delivery.messageId) this.#update(delivery.id, { messageId: id })
  }

  /** Returns whether to come back later. */
  async #deliver(delivery: Delivery): Promise<boolean> {
    if (delivery.kind === 'show') {
      const collection = getCollection(this.#d.ctx, delivery.ref)
      await this.#final(delivery, collection, 'complete')
      return false
    }
    if (delivery.kind === 'update') return this.#deliverUpdate(delivery)
    return this.#deliverSubmission(delivery, delivery.ref, delivery.ref)
  }

  /**
   * An update started from the bot covers one collection: its message is
   * that capture's, linking to the update's record. Returns whether to come
   * back later.
   */
  async #deliverUpdate(delivery: Delivery): Promise<boolean> {
    const { db } = this.#d.ctx
    const update = db
      .select()
      .from(updates)
      .where(eq(updates.id, delivery.ref))
      .get()
    if (!update) return false
    const item = db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.updateId, update.id))
      .orderBy(asc(submissions.createdAt))
      .limit(1)
      .get()
    if (!item) {
      const running = update.state === 'running'
      await this.#status(delivery, {
        text: running ? '排队中…' : '无法更新：内容不存在或已删除',
        entities: [],
      })
      return running
    }
    const more = await this.#deliverSubmission(delivery, item.id, update.id)
    // The lists (抓关系网) run after the profile; the record shows them.
    return more || !updateRecord(db, update.id).done
  }

  /** A request's message; `recordId` is the record its links open. */
  async #deliverSubmission(
    delivery: Delivery,
    submissionId: string,
    recordId: string,
  ): Promise<boolean> {
    const { db } = this.#d.ctx
    const row = db
      .select({
        submission: submissions,
        capture: captures,
        url: collections.url,
      })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .innerJoin(collections, eq(collections.id, captures.collectionId))
      .where(eq(submissions.id, submissionId))
      .get()
    if (!row) {
      // A profile named by its handle, still being identified.
      const pending = loadRequest(db, submissionId)
      if (pending?.state === 'pending') {
        await this.#status(delivery, {
          text: `正在识别账号…\n${pending.input}`,
          entities: [],
        })
        return true
      }
      if (pending)
        await this.#status(delivery, {
          text: `收藏失败\n输入：${pending.input}\n${pending.error}`,
          entities: [],
        })
      // Deleted meanwhile (e.g. delete all): nothing left to say.
      return false
    }
    const { submission, capture } = row
    if (capture.isCollection && submission.relatedState !== 'none') {
      const progress = collectionProgress(db, submission.id)
      const first = progress.pages[0]?.capture ?? capture
      await this.#status(
        delivery,
        progressMessage(
          {
            submissionId: submission.id,
            recordId,
            collectionId: first.collectionId,
            url: row.url,
            input: submission.input,
            rootState: first.state,
            rootError: first.error,
            total: progress.total,
            complete: progress.complete,
            partial: progress.partial,
            failed: progress.failed,
            known: progress.known,
            added: progress.added,
            updated: progress.updated,
            done: progress.done,
            stopped: progress.stopped,
            paused: pausedRecord(db, recordId),
            limited: rateLimitedMembers(
              db,
              progress.pages.map((page) => page.submission.id),
            ),
            next: progress.next,
            maxBatch: progress.maxBatch,
            pageError: progress.error === 'partial_pages',
            reasons: collectionReasons(db, progress.pages),
          },
          { webAppUrl: this.#d.webAppUrl, group: delivery.group },
        ),
      )
      return !progress.done
    }
    if (capture.state === 'queued' || capture.state === 'downloading') {
      const heading =
        capture.state === 'queued'
          ? `${waitLabel(captureWaits(db, [capture.id]).get(capture.id))}…`
          : '正在保存媒体…'
      const keyboard: Keyboard = [
        [{ text: '查看状态', callback_data: `/status ${capture.id}` }],
      ]
      const progress = webRoute(
        this.#d.webAppUrl,
        '在小程序查看进度',
        `/captures/${recordId}`,
      )
      if (progress) keyboard[0]!.push(progress)
      await this.#status(delivery, {
        text: submission.input ? `${heading}\n${submission.input}` : heading,
        entities: [],
        keyboard,
      })
      return true
    }
    if (capture.state === 'failed') {
      const keyboard: Keyboard = [
        [{ text: '重试', callback_data: `/retry ${capture.collectionId}` }],
      ]
      const details = webRoute(
        this.#d.webAppUrl,
        '在小程序查看详情',
        `/captures/${recordId}`,
      )
      if (details) keyboard[0]!.push(details)
      await this.#status(delivery, {
        text: `收藏失败\n输入：${submission.input}\n${capture.error}`,
        entities: [],
        keyboard,
      })
      return false
    }
    await this.#final(
      delivery,
      getCaptureCollection(this.#d.ctx, capture.id),
      capture.state,
    )
    return false
  }

  /** The collection itself: media first, then text, resumable by part. */
  async #final(
    delivery: Delivery,
    collection: Parameters<typeof collectionMessage>[0],
    state: string,
  ): Promise<void> {
    const message = collectionMessage(collection, state, {
      webAppUrl: this.#d.webAppUrl,
    })
    const keyboard = this.#keyboard(delivery, message.keyboard)
    const parts: Part[] = deliveryParts(
      message.text,
      message.entities as MessageEntity[],
      messageAssets(collection),
    )
    const target = this.#target(delivery)
    const api = this.#d.api
    let header = delivery.messageId
    let progress = delivery.progress
    if (progress === 0 && parts[0]?.kind === 'media' && header) {
      // The album goes below the user's link, so the status message goes.
      await deleteMessage(api, delivery.chatId, header)
      header = null
      this.#update(delivery.id, { messageId: null })
    }
    // The header is the first part with text; its message gets the keyboard.
    const headerIndex = parts.findIndex(
      (p) =>
        p.kind === 'text' ||
        (p.kind === 'media' && p.assets.length === 1 && !!p.caption),
    )
    for (let i = progress; i < parts.length; i++) {
      const part = parts[i]!
      if (part.kind === 'media') {
        if (part.assets.length === 1) {
          const sent = await this.#d.media.sendItem(target, part.assets[0]!, {
            text: part.caption,
            entities: part.entities,
          })
          if (i === headerIndex) header = sent.message_id
        } else {
          await this.#d.media.sendAlbum(target, part.assets)
        }
      } else if (part.kind === 'buttons') {
        if (header)
          try {
            await api.editMessageReplyMarkup(delivery.chatId, header, {
              reply_markup: { inline_keyboard: keyboard ?? [] },
            })
          } catch (error) {
            if (!description(error).includes('message is not modified'))
              throw error
          }
      } else if (i === headerIndex) {
        const rendered = { text: part.text, entities: part.entities, keyboard }
        header =
          header && i === 0
            ? await editText(api, target, header, rendered)
            : await sendText(api, target, rendered)
      } else {
        await sendText(api, target, {
          text: part.text,
          entities: part.entities,
        })
      }
      progress = i + 1
      this.#update(delivery.id, { progress, messageId: header })
    }
  }
}

/** An update record that is paused, or any record while all work is. */
function pausedRecord(db: CaptureContext['db'], recordId: string): boolean {
  if (readJobControl(db).paused) return true
  return !!db
    .select({ id: updates.id })
    .from(updates)
    .where(and(eq(updates.id, recordId), isNotNull(updates.pausedAt)))
    .get()
}
