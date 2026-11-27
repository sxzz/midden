// Who a request is, once its login is checked (docs/design/multi-user.md
// §2.1), and what that lets it see. Reads that differ by who asks take it
// from their context (`ReadContext.principal`, `AgentReader.principal`), so
// a read that could not say whom it is for does not type-check.
import type { UserRole } from '#db/schema.ts'
import type { Permission } from '#tokens/tokens.ts'

export interface Principal {
  userId: string
  role: UserRole
  /**
   * A web session, an API token, or `system`: the worker's own reads and
   * the public pages', which see as the admin and are nobody's.
   */
  via: 'session' | 'token' | 'system'
  /** A token's permission as made; a viewer's token reads only, whatever it says. */
  permission?: Permission
}

/**
 * The worker's reads (folder counts, expanding an update, maintenance) and
 * the public pages': as the admin, but no user. Never a default: a read
 * names it.
 */
export const SYSTEM: Principal = Object.freeze({
  userId: '',
  role: 'admin',
  via: 'system',
})

/**
 * What a principal may see. Code asks this, not the role: in phase B a
 * user's own tags and folders map here. In A the admin sees everything and
 * a viewer none of these.
 */
export interface Sight {
  tags: boolean
  notes: boolean
  /** Capture records, their progress and jobs. */
  records: boolean
  captureAccounts: boolean
  /** Folders that are not publicly shared, and what any folder selects by. */
  allFolders: boolean
}

export function sees(principal: Principal): Sight {
  const admin = principal.role === 'admin'
  return {
    tags: admin,
    notes: admin,
    records: admin,
    captureAccounts: admin,
    allFolders: admin,
  }
}

/**
 * Whether it may write: the admin's session, or the admin's read and write
 * token. A viewer only reads, by session or token; managing their own
 * passkeys, sessions and tokens is the exception (`sessionOnly`).
 */
export function writes(principal: Principal): boolean {
  if (principal.role !== 'admin') return false
  return principal.via !== 'token' || principal.permission === 'rw'
}

/**
 * What the web app offers this principal (`GET /v1/session`'s `can`): it
 * shows controls by these, never by the role. The server still decides
 * every request.
 */
export function abilities(principal: Principal) {
  const write = writes(principal)
  const session = principal.role === 'admin' && principal.via === 'session'
  return {
    capture: write,
    organize: write,
    share: write,
    delete: session,
    admin: session,
  }
}
