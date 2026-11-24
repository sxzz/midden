import { pino } from 'pino'
import type { Logger } from '#log.ts'

export type LogEntry = Record<string, any> & { level: number; msg: string }

/** A logger that keeps its entries, parsed, for assertions. */
export function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const logger = pino(
    { level: 'trace' },
    { write: (line: string) => entries.push(JSON.parse(line)) },
  )
  return { logger, entries }
}

export const levels = { info: 30, warn: 40, error: 50 } as const
