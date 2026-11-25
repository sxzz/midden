import { Api, type ApiClientOptions } from 'grammy'
import type { Logger } from '#log.ts'

const TIMEOUT_SECONDS = 15

/**
 * Messages to the owner without running the bot, for the worker process:
 * the web process owns the bot (polling, commands, deliveries), and the
 * Bot API takes sends from anywhere. Failures are only logged.
 */
export function sendOnlyNotifier(options: {
  token: string
  owner: string
  logger: Logger
  client?: ApiClientOptions
}): (text: string) => void {
  const api = new Api(options.token, {
    timeoutSeconds: TIMEOUT_SECONDS,
    ...options.client,
  })
  return (text) => {
    api
      .sendMessage(Number(options.owner), text)
      .catch((error: unknown) =>
        options.logger.error({ err: error }, 'telegram notice failed'),
      )
  }
}
