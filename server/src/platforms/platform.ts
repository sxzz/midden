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
}

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
