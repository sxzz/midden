import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'node:crypto'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { selectedConnection } from '#capture/records.ts'
import {
  accountCredentials,
  accountSelections,
  connections,
} from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { isProviderFailure, type Platform } from '#platforms/platform.ts'
import { defaultProvider, supports } from '#platforms/registry.ts'
import { status } from '#platforms/rpc.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Transaction } from '#db/client.ts'
import type { Provider } from '#platforms/protocol.ts'
import type { Vault } from './vault.ts'

const MAX_NAME = 100
const MAX_CREDENTIAL = 16_384
const CHECK_TIMEOUT = 40_000
const INVALID_CREDENTIAL = new Set<number>([
  status.INVALID_ARGUMENT,
  status.UNAUTHENTICATED,
  status.PERMISSION_DENIED,
  status.FAILED_PRECONDITION,
])

export interface AccountsContext extends CaptureContext {
  vault: Vault
}

/** The provider a platform imports accounts with, if it takes any. */
function accountProvider(platform: Platform): Provider {
  const provider = platform.description.providers.find(
    (p) => p.defaultProvider && p.authentication === 'session',
  )
  if (
    !provider ||
    !supports(provider, 'credential.prepare') ||
    !supports(provider, 'connection.check')
  )
    throw new AppError('unsupported')
  return provider
}

function deleteOrphanCredentials(tx: Transaction): void {
  tx.delete(accountCredentials)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.credentialRef} = ${accountCredentials.id})`,
    )
    .run()
}

function verificationError(error: unknown): Error {
  if (isProviderFailure(error) && INVALID_CREDENTIAL.has(error.code))
    return new AppError('invalid_credential')
  return new Error(
    `account verification failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}

/**
 * Import an account from user input (e.g. exported cookies), verify it and
 * select it for its platform. Importing the same account again updates it.
 */
export async function addAccount(
  ctx: AccountsContext,
  adapterId: string,
  input: { credential: Uint8Array; name?: string },
): Promise<{ id: string }> {
  const name = input.name?.trim() || '采集账号'
  if (!input.credential.length || Buffer.byteLength(name) > MAX_NAME)
    throw new AppError('invalid_account')
  const platform = ctx.platforms.byId(adapterId)
  const provider = accountProvider(platform)
  let credential
  try {
    credential = platform.prepareCredential(provider.id, input.credential)
  } catch (error) {
    throw verificationError(error)
  }
  if (!credential.data.length || credential.data.length > MAX_CREDENTIAL)
    throw new Error('adapter returned invalid credential')
  let account
  try {
    account = await platform.checkConnection(
      provider.id,
      credential,
      AbortSignal.timeout(CHECK_TIMEOUT),
    )
  } catch (error) {
    throw verificationError(error)
  }
  if (!account.accountId)
    throw new Error('account verification failed: no account id')
  const ref = randomUUIDv7()
  const sealed = ctx.vault.seal(ref, credential.data)
  return ctx.db.transaction((tx) => {
    const existing = tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.adapterId, adapterId),
          eq(connections.providerId, provider.id),
          eq(connections.accountId, account.accountId),
          ne(connections.state, 'revoked'),
        ),
      )
      .get()
    tx.insert(accountCredentials).values({ id: ref, ciphertext: sealed }).run()
    const id = existing?.id ?? randomUUIDv7()
    if (existing)
      tx.update(connections)
        .set({
          name,
          state: 'ready',
          credentialRef: ref,
          username: account.username,
          revision: existing.revision + 1,
        })
        .where(eq(connections.id, id))
        .run()
    else
      tx.insert(connections)
        .values({
          id,
          adapterId,
          providerId: provider.id,
          name,
          accountId: account.accountId,
          username: account.username,
          state: 'ready',
          credentialRef: ref,
        })
        .run()
    select(tx, adapterId, id)
    deleteOrphanCredentials(tx)
    return { id }
  })
}

function select(
  tx: Transaction,
  adapterId: string,
  connectionId: string | null,
) {
  tx.insert(accountSelections)
    .values({ adapterId, connectionId })
    .onConflictDoUpdate({
      target: accountSelections.adapterId,
      set: { connectionId },
    })
    .run()
}

/** Remove an account; captures still using it fail when they next check. */
export function revokeAccount(ctx: CaptureContext, id: string): void {
  ctx.db.transaction((tx) => {
    const connection = tx
      .select()
      .from(connections)
      .where(eq(connections.id, id))
      .get()
    if (!connection) throw new AppError('not_found')
    if (connection.state === 'revoked') return
    tx.update(connections)
      .set({
        state: 'revoked',
        credentialRef: null,
        revision: connection.revision + 1,
      })
      .where(eq(connections.id, id))
      .run()
    tx.update(accountSelections)
      .set({ connectionId: null })
      .where(eq(accountSelections.connectionId, id))
      .run()
    deleteOrphanCredentials(tx)
  })
}

/** Verify a stored account again, refreshing its username. */
export async function checkAccount(
  ctx: AccountsContext,
  id: string,
): Promise<void> {
  const connection = ctx.db
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get()
  if (!connection) throw new AppError('not_found')
  if (connection.state !== 'ready' || !connection.credentialRef)
    throw new AppError('connection')
  const platform = ctx.platforms.byId(connection.adapterId)
  const credential = {
    data: ctx.vault.open(ctx.db, connection.credentialRef),
  }
  try {
    const account = await platform.checkConnection(
      connection.providerId,
      credential,
      AbortSignal.timeout(CHECK_TIMEOUT),
    )
    const updated = ctx.db
      .update(connections)
      .set({ username: account.username })
      .where(
        and(
          eq(connections.id, id),
          eq(connections.revision, connection.revision),
          eq(connections.state, 'ready'),
          eq(connections.accountId, account.accountId),
        ),
      )
      .run()
    if (updated.changes === 0) throw new AppError('connection')
  } catch (error) {
    if (isProviderFailure(error) && error.code === status.UNAUTHENTICATED)
      ctx.db
        .update(connections)
        .set({ state: 'reauth_required' })
        .where(
          and(
            eq(connections.id, id),
            eq(connections.revision, connection.revision),
            eq(connections.state, 'ready'),
          ),
        )
        .run()
    throw error
  }
}

/** Choose the account a platform captures with; '' means anonymous. */
export function selectAccount(
  ctx: CaptureContext,
  adapterId: string,
  connectionId: string,
): void {
  const platform = ctx.platforms.byId(adapterId)
  if (!connectionId) {
    defaultProvider(platform, 'none')
    ctx.db.transaction((tx) => select(tx, adapterId, null))
    return
  }
  ctx.db.transaction((tx) => {
    const connection = tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get()
    if (connection?.adapterId !== adapterId || connection.state === 'revoked')
      throw new AppError('not_found')
    if (connection.state !== 'ready') throw new AppError('connection')
    select(tx, adapterId, connectionId)
  })
}

export function listAccounts(ctx: CaptureContext) {
  const platforms = ctx.platforms.all().map((platform) => {
    const { adapterId, displayName, providers } = platform.description
    const session = providers.find(
      (p) => p.defaultProvider && p.authentication === 'session',
    )
    let canAdd = true
    try {
      accountProvider(platform)
    } catch {
      canAdd = false
    }
    return {
      id: adapterId,
      name: displayName || adapterId,
      help: session?.credentialHelp ?? '',
      public: providers.some(
        (p) => p.defaultProvider && p.authentication === 'none',
      ),
      canAdd,
      selected: selectedConnection(ctx.db, adapterId),
    }
  })
  const selected = new Set(platforms.map((p) => p.selected).filter(Boolean))
  const accounts = ctx.db
    .select()
    .from(connections)
    .where(ne(connections.state, 'revoked'))
    .orderBy(asc(connections.name), asc(connections.id))
    .all()
    .map((connection) => ({
      id: connection.id,
      name: connection.name,
      username: connection.username ?? '',
      state: connection.state,
      platform: connection.adapterId,
      selected: selected.has(connection.id),
    }))
  return { platforms, accounts }
}
