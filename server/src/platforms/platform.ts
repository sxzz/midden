import type { Logger } from '#log.ts'
import type {
  CheckConnectionResponse,
  Credential,
  DescribeResponse,
  FetchRequest,
  FetchResponse,
  ResolveResponse,
} from './protocol.ts'
import type { Metadata, status } from './rpc.ts'

/** One supported site, called in-process by the core. */
export interface Platform {
  readonly description: DescribeResponse
  resolve: (url: string) => ResolveResponse
  fetch: (req: FetchRequest, signal: AbortSignal) => Promise<FetchResponse>
  /** Turn user-supplied input (e.g. exported cookies) into a credential. */
  prepareCredential: (providerId: string, input: Uint8Array) => Credential
  checkConnection: (
    providerId: string,
    credential: Credential | undefined,
    signal: AbortSignal,
  ) => Promise<CheckConnectionResponse>
  /** Reading who an account follows and who follows it, when supported. */
  relations?: Relations
}

/** Who an account follows, or who follows it. */
export type RelationList = 'following' | 'followers'

/** One page of an account's following or followers list. */
export interface RelationsRequest {
  list: RelationList
  /** The account's external id, as its profile entity has it. */
  externalId: string
  /** Empty for the first page. */
  cursor: string
  /**
   * The provider the list is read through: `Relations.publicProviderId`
   * without an account, or `Relations.providerId` with `credential`.
   */
  providerId: string
  credential: Credential | undefined
  /** For what the platform does along the way, such as switching queries. */
  logger: Logger
}

export interface RelationsPage {
  /**
   * Each listed account as a profile fetch of it would describe it, from the
   * list's own user data: graph rooted at the profile, external id canonical.
   */
  accounts: FetchResponse[]
  /** Empty at the end of the list. */
  nextCursor: string
}

export interface Relations {
  /** The provider a protected account's lists are read through, with an account. */
  providerId: string
  /** The provider a public account's lists are read through, without one. */
  publicProviderId: string
  /**
   * Pointer into the profile entity's data at whether the account is
   * protected. Only `false` there sends its lists to the public provider.
   */
  protectedPath: string
  /** Pointers into the profile entity's data at each list's size. */
  counts: Record<RelationList, string>
  list: (req: RelationsRequest, signal: AbortSignal) => Promise<RelationsPage>
}

/**
 * Trailer on a failure caused by a rate limit (HTTP 429, X's error 88,
 * Instagram's "please wait"): the job waits for the limit's end rather than
 * count the failure as an attempt (`#capture/rate-limits.ts`).
 */
export const rateLimitedKey = 'rate-limited'

/** Errors platform code raises on purpose, with a status the core classifies. */
export interface ProviderFailure extends Error {
  code: status
  metadata: Metadata
}

export function isProviderFailure(error: unknown): error is ProviderFailure {
  return (
    error instanceof Error &&
    typeof (error as Partial<ProviderFailure>).code === 'number' &&
    typeof (error as Partial<ProviderFailure>).metadata?.get === 'function'
  )
}

// Upper bound for one platform call, on top of the job's own timeout.
const CALL_TIMEOUT = 40_000

/**
 * Run a platform call with its own deadline. Unexpected errors are replaced
 * by a generic failure so upstream details never reach users or logs as
 * messages.
 */
export async function guard<T>(
  signal: AbortSignal,
  failure: (code: status, message: string) => ProviderFailure,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT)])
  try {
    return await run(combined)
  } catch (error) {
    if (isProviderFailure(error)) throw error
    throw failure(
      combined.aborted ? 4 /* DEADLINE_EXCEEDED */ : 14 /* UNAVAILABLE */,
      '平台请求失败',
    )
  }
}
