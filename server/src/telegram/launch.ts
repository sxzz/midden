import { setTimeout as sleep } from 'node:timers/promises'
import { GrammyError } from 'grammy'
import { startBot, type BotOptions, type RunningBot } from './bot.ts'

export type BotState = 'starting' | 'running' | 'failed' | 'stopped'

export interface BotHandle {
  state: () => BotState
  /**
   * A short message to the owner. Until the bot runs the latest few are
   * held and sent once it does; failures are only logged.
   */
  notify: (text: string) => void
  /** Ends startup or the running bot; waits on Telegram only briefly. */
  stop: () => Promise<void>
  /** Settles once the bot runs, has failed for good, or was stopped. */
  settled: Promise<void>
}

export interface LaunchOptions extends BotOptions {
  /** The limit for each setup request. */
  requestTimeoutMs?: number
  /** The first wait before another attempt; it doubles up to the maximum. */
  retryDelayMs?: number
  maxRetryDelayMs?: number
  /** How long stopping may wait for Telegram. */
  stopTimeoutMs?: number
}

const REQUEST_TIMEOUT = 15_000
const RETRY_DELAY = 5000
const MAX_RETRY_DELAY = 5 * 60_000
const STOP_TIMEOUT = 5000
const HELD_NOTICES = 20

/** Telegram refused the request itself: trying again cannot help. */
function permanent(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code < 500 &&
    error.error_code !== 429
  )
}

/**
 * Start the bot in the background, so the server serves without it. A
 * failed attempt (a timeout, a network error, 5xx, 429) is tried again after
 * a growing delay, or after Telegram's `retry_after` when that is longer;
 * Telegram refusing the setup (a 4xx such as a revoked token) ends it.
 */
export function launchBot(options: LaunchOptions): BotHandle {
  const { logger } = options.ctx
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT
  const maxDelay = options.maxRetryDelayMs ?? MAX_RETRY_DELAY
  const abort = new AbortController()
  let state: BotState = 'starting'
  let running: RunningBot | undefined
  const held: string[] = []

  const dropped = (text: string | undefined, reason: string) =>
    logger.warn({ text, reason }, 'telegram notice dropped')

  const settled = (async () => {
    let delay = options.retryDelayMs ?? RETRY_DELAY
    for (let attempt = 1; ; attempt++) {
      try {
        running = await startBot(options, abort.signal, timeoutMs)
        // Stopped as the last request answered: stop() ends it.
        if (abort.signal.aborted) return
        state = 'running'
        logger.info({ attempt }, 'telegram bot started')
        for (const text of held.splice(0)) running.notify(text)
        return
      } catch (error) {
        if (abort.signal.aborted) return
        if (permanent(error)) {
          state = 'failed'
          logger.error({ err: error, attempt }, 'telegram bot could not start')
          for (const text of held.splice(0)) dropped(text, 'bot failed')
          return
        }
        const retryAfter =
          error instanceof GrammyError
            ? error.parameters.retry_after
            : undefined
        const wait = Math.max(delay, (retryAfter ?? 0) * 1000)
        logger.warn(
          { err: error, attempt, retryInMs: wait },
          'telegram bot start failed; retrying',
        )
        try {
          await sleep(wait, undefined, { signal: abort.signal })
        } catch {
          return
        }
        delay = Math.min(delay * 2, maxDelay)
      }
    }
  })()

  return {
    state: () => state,
    notify: (text) => {
      if (state === 'running') running!.notify(text)
      else if (state !== 'starting') dropped(text, `bot ${state}`)
      else if (held.push(text) > HELD_NOTICES)
        dropped(held.shift(), 'too many before the bot started')
    },
    settled,
    stop: async () => {
      if (state === 'stopped') return
      abort.abort()
      await settled
      state = 'stopped'
      for (const text of held.splice(0)) dropped(text, 'bot stopped')
      if (!running) return
      // bot.stop() confirms the last update with a request of grammY's
      // default timeout, far longer than a container is given to stop.
      const limit = new AbortController()
      await Promise.race([
        running
          .stop()
          .catch((error: unknown) =>
            logger.warn({ err: error }, 'telegram bot did not stop cleanly'),
          ),
        sleep(options.stopTimeoutMs ?? STOP_TIMEOUT, undefined, {
          signal: limit.signal,
        }).then(
          () => logger.warn('telegram bot stop timed out'),
          () => {},
        ),
      ]).finally(() => limit.abort())
    },
  }
}
