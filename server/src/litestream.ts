import { createServer, type Server } from 'node:http'
import type { Logger } from '#log.ts'

/**
 * Litestream's heartbeat-url (litestream.yml) points here. compose.yaml
 * publishes only the main port, so this one is reachable from the sidecar
 * and not through the reverse proxy.
 */
export const HEARTBEAT_PORT = 8081
const HEARTBEAT_PATH = '/litestream/heartbeat'
/** Litestream pings every 5 minutes; this is four missed pings. */
const STALE_AFTER = 20 * 60_000
const CHECK_INTERVAL = 60_000

export interface LitestreamWatch {
  server: Server
  /** Record a heartbeat, as a request to the heartbeat path does. */
  beat: () => void
  /** Tell the owner once heartbeats have been missing too long. */
  check: () => void
  close: () => void
}

/**
 * Litestream pings only while every sync succeeds, so missing pings mean it
 * is not running or cannot upload (credentials, network). Tell the owner
 * when they go missing and when they come back. The clock starts with the
 * server, so a sidecar that never comes up is reported too.
 */
export function watchLitestream(options: {
  host: string
  port?: number
  logger: Logger
  notify: (text: string) => void
  now?: () => number
  staleAfter?: number
}): LitestreamWatch {
  const now = options.now ?? Date.now
  const staleAfter = options.staleAfter ?? STALE_AFTER
  let last = now()
  let missing = false

  const beat = () => {
    last = now()
    if (!missing) return
    missing = false
    options.logger.info('litestream heartbeat resumed')
    options.notify('数据库备份：Litestream 的心跳已恢复')
  }
  const check = () => {
    if (missing || now() - last < staleAfter) return
    missing = true
    const minutes = Math.round(staleAfter / 60_000)
    options.logger.error(
      { lastHeartbeat: new Date(last).toISOString() },
      'litestream heartbeat missing',
    )
    options.notify(`数据库备份：${minutes} 分钟没有收到 Litestream 的心跳`)
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === HEARTBEAT_PATH) {
      beat()
      res.writeHead(204).end()
    } else res.writeHead(404).end()
  })
  server.on('error', (error) =>
    options.logger.error(
      { err: error },
      'litestream heartbeat listener failed',
    ),
  )
  server.listen(options.port ?? HEARTBEAT_PORT, options.host)
  const timer = setInterval(check, CHECK_INTERVAL)
  timer.unref()

  return {
    server,
    beat,
    check,
    close: () => {
      clearInterval(timer)
      server.close()
    },
  }
}
