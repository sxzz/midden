import { parseArgs } from 'node:util'
import { isAppError } from '#errors.ts'
import { createToken, parseExpiry, type Permission } from './tokens.ts'
import type { Database } from '#db/client.ts'

const USAGE =
  'usage: token create --ro|--rw [--label <label>] [--expires <ISO time|30m|12h|7d|never>]'

/**
 * `token create`: the secret alone on stdout, so a script can capture it,
 * and what it is on stderr. Exit code 1 for bad arguments.
 */
export function tokenCreate(
  db: Database,
  args: string[],
  print: { out: (line: string) => void; err: (line: string) => void },
  now = Date.now(),
): number {
  let values
  try {
    values = parseArgs({
      args,
      options: {
        ro: { type: 'boolean' },
        rw: { type: 'boolean' },
        label: { type: 'string' },
        expires: { type: 'string' },
      },
    }).values
  } catch (error) {
    print.err(error instanceof Error ? error.message : String(error))
    print.err(USAGE)
    return 1
  }
  if (Boolean(values.ro) === Boolean(values.rw)) {
    print.err('give one of --ro (read only) or --rw (read and write)')
    print.err(USAGE)
    return 1
  }
  const permission: Permission = values.ro ? 'ro' : 'rw'
  try {
    const { token, secret } = createToken(
      db,
      {
        label: values.label ?? 'cli',
        permission,
        expiresAt: parseExpiry(values.expires ?? 'never', now),
      },
      now,
    )
    print.out(secret)
    print.err(
      `${token.label} · ${permission} · ${token.expires_at ? `expires ${token.expires_at}` : 'never expires'}`,
    )
    return 0
  } catch (error) {
    if (!isAppError(error)) throw error
    print.err(
      `${error.message} (--label: 1 to 64 characters; --expires: a future ISO time, 30m, 12h, 7d or never)`,
    )
    return 1
  }
}
