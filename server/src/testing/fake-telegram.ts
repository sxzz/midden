import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * What the fake answers to one call: a result, a Bot API error, or nothing
 * at all (`hang`) until the client gives up.
 */
export type TelegramReply =
  | { result: unknown }
  | {
      error_code: number
      description: string
      parameters?: { retry_after?: number }
    }
  | 'hang'

export interface TelegramCall {
  method: string
  body: Record<string, unknown>
}

const ME = {
  id: 42,
  is_bot: true,
  first_name: 'Midden',
  username: 'MiddenBot',
}

/** The default: setup succeeds, polling finds no updates. */
export function defaultReply(call: TelegramCall): TelegramReply {
  if (call.method === 'getMe') return { result: ME }
  if (call.method === 'getUpdates') return { result: [] }
  if (call.method === 'sendMessage')
    return {
      result: {
        message_id: 1,
        date: 0,
        chat: { id: Number(call.body.chat_id), type: 'private' },
        text: call.body.text,
      },
    }
  return { result: true }
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk as Uint8Array)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A Bot API server on localhost that records calls; `reply` decides each
 * answer. getUpdates with a long-poll timeout is held briefly, as Telegram
 * would, so polling does not spin.
 */
export class FakeTelegram {
  calls: TelegramCall[] = []
  reply: (call: TelegramCall) => TelegramReply = defaultReply
  #server: Server | undefined
  #pending = new Set<IncomingMessage>()

  get apiRoot(): string {
    const address = this.#server!.address()
    if (!address || typeof address === 'string') throw new Error('not started')
    return `http://127.0.0.1:${address.port}`
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }

  async start(): Promise<this> {
    this.#server = createServer(async (req, res) => {
      const method = req.url?.split('/').at(-1) ?? ''
      const call = { method, body: await readBody(req) }
      this.calls.push(call)
      const reply = this.reply(call)
      if (reply === 'hang') {
        this.#pending.add(req)
        req.on('close', () => this.#pending.delete(req))
        return
      }
      const send = () => {
        if (res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            'result' in reply
              ? { ok: true, ...reply }
              : { ok: false, ...reply },
          ),
        )
      }
      if (method === 'getUpdates' && call.body.timeout) setTimeout(send, 50)
      else send()
    })
    await new Promise<void>((resolve) =>
      this.#server!.listen(0, '127.0.0.1', resolve),
    )
    return this
  }

  async stop(): Promise<void> {
    for (const req of this.#pending) req.socket.destroy()
    this.#server?.closeAllConnections()
    await new Promise((resolve) => this.#server?.close(resolve))
  }
}
