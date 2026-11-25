import { createServer, type Server } from 'node:http'
import {
  heartbeatTimeoutMinutes,
  readSetting,
  writeSetting,
} from '#settings.ts'
import type { Database } from '#db/client.ts'
import type { Logger } from '#log.ts'

/**
 * Litestream's heartbeat-url (litestream.yml) points here. compose.yaml
 * publishes only the main port, so this one is reachable from the sidecar
 * and not through the reverse proxy.
 */
export const HEARTBEAT_PORT = 8081
const HEARTBEAT_PATH = '/litestream/heartbeat'
const CHECK_INTERVAL = 60_000
/** The last heartbeat, in epoch milliseconds, kept across restarts. */
const LAST_BEAT_KEY = 'litestream_last_heartbeat_at'

export interface LitestreamStatus {
  enabled: boolean
  last_heartbeat_at: string | null
  stale: boolean
  /** Minutes without a heartbeat before the owner is told. */
  stale_after_minutes: number | null
}

export interface LitestreamWatch {
  server: Server
  /** Record a heartbeat, as a request to the heartbeat path does. */
  beat: () => void
  /** Tell the owner once heartbeats have been missing too long. */
  check: () => void
  status: () => LitestreamStatus
  close: () => void
}

/**
 * Litestream pings only while every sync succeeds (an idle database
 * included), so missing pings mean it is not running or cannot upload
 * (credentials, network). Tell the owner when they go missing and when they
 * come back. The clock starts with the server, so a sidecar that never comes
 * up is reported too; the threshold is the admin setting, read on every check.
 */
export function watchLitestream(options: {
  db: Database
  host: string
  port?: number
  logger: Logger
  notify: (text: string) => void
  now?: () => number
}): LitestreamWatch {
  const { db } = options
  const now = options.now ?? Date.now
  const started = now()
  const stored = Number(readSetting(db, LAST_BEAT_KEY))
  let last = Number.isFinite(stored) && stored > 0 ? stored : undefined
  let received = false
  let missing = false

  const staleAfter = () => heartbeatTimeoutMinutes(db) * 60_000
  // A heartbeat from before this start does not count against the new clock.
  const silent = () => now() - Math.max(last ?? 0, started)

  const beat = () => {
    last = now()
    try {
      writeSetting(db, LAST_BEAT_KEY, String(last))
    } catch (error) {
      options.logger.warn({ err: error }, 'litestream heartbeat not saved')
    }
    if (missing) {
      missing = false
      options.logger.info('litestream heartbeat resumed')
      options.notify('数据库备份：Litestream 的心跳已恢复')
    } else if (!received) {
      options.logger.info('litestream heartbeat received')
    }
    received = true
  }
  const check = () => {
    if (missing || silent() < staleAfter()) return
    missing = true
    options.logger.error(
      { lastHeartbeat: last ? new Date(last).toISOString() : null },
      'litestream heartbeat missing',
    )
    options.notify(
      `数据库备份：${Math.round(staleAfter() / 60_000)} 分钟没有收到 Litestream 的心跳`,
    )
  }
  const status = (): LitestreamStatus => ({
    enabled: true,
    last_heartbeat_at: last ? new Date(last).toISOString() : null,
    stale: silent() >= staleAfter(),
    stale_after_minutes: heartbeatTimeoutMinutes(db),
  })

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
  const timer = setInterval(() => {
    try {
      check()
    } catch (error) {
      options.logger.warn({ err: error }, 'litestream heartbeat check failed')
    }
  }, CHECK_INTERVAL)
  timer.unref()

  return {
    server,
    beat,
    check,
    status,
    close: () => {
      clearInterval(timer)
      server.close()
    },
  }
}
