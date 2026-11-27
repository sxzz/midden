import { pino, type Logger } from 'pino'

export type { Logger }

/**
 * Logs go to stdout only, as JSON lines: `docker compose logs` has all of
 * them (the json-file driver rotates them), and the app writes no files of
 * its own besides the database and the media store.
 */
export function createLogger(level: string): Logger {
  return pino({ level })
}
