import { userAPI } from '@fxembed/atmosphere/providers/twitter/profile'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { ProviderError, readJSON, responseError } from './provider.ts'
import { accountTransport } from './session.ts'
import type { SessionCredential } from './credential.ts'
import type { TwitterBuildHost } from '@fxembed/atmosphere/providers/twitter/build-host'

const ID = /^\d+$/

/** What X said of a handle: whose it is, that there is none, or nothing. */
type Answer = { id: string } | 'none' | 'miss'

/** Who goes by a handle, as FxTwitter's or X's user response says. */
function answer(data: any): Answer {
  const id = data?.code === 200 ? data.user?.id : data?.id
  // A suspended account still has its id: the account is known, and its
  // capture says it is suspended.
  if (
    (data?.code === 200 ||
      (data?.code === 404 && data.reason === 'suspended')) &&
    typeof id === 'string' &&
    ID.test(id)
  )
    return { id }
  return data?.code === 404 && !data.reason ? 'none' : 'miss'
}

export const handleMiss = () => {
  const error = new ProviderError(
    status.UNAVAILABLE,
    '暂时无法读取（平台按用户名查询失败）',
  )
  error.handleMiss = true
  return error
}

/**
 * Ask FxTwitter who goes by `handle`. Its 404 without a reason also comes
 * for accounts that exist (for some only in one letter case), so it is no
 * answer either way; only a rate limit stops the asking.
 */
async function publicAnswer(
  handle: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  endpoint: string,
): Promise<Answer> {
  const response = await upstream(
    fetcher,
    `${endpoint}/${encodeURIComponent(handle)}`,
    {
      signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Monitor/0.4' },
    },
  )
  if (response.status === 429)
    throw responseError(429, response.headers.get('retry-after'), 'profile')
  try {
    const found = answer(await readJSON(response))
    return found === 'none' ? 'miss' : found
  } catch {
    return 'miss'
  }
}

/** Ask X itself with the account (UserByScreenName): a reliable answer. */
export async function sessionAnswer(
  handle: string,
  credential: SessionCredential,
  signal: AbortSignal,
  proxy = accountTransport(credential, signal, {
    target: 'profile',
    responses: [],
  }),
): Promise<Answer> {
  let failure: unknown
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: {
      fetch: (input, init) =>
        proxy!.fetch(input, init).catch((error: unknown) => {
          failure = error
          throw error
        }),
    },
    shouldTranscodeGif: () => false,
  }
  const data = await userAPI(handle, host)
  const found = answer(data)
  // The request failed rather than X saying there is no such account.
  if (typeof found !== 'object' && failure) throw failure
  return found
}

export interface IdentifyOptions {
  fetcher?: typeof fetch
  endpoint?: string
  session?: typeof sessionAnswer
}

/**
 * The id of the account that goes by `handle` now: FxTwitter with the
 * handle as written, then in lower case, then X with the capture account
 * when there is one. Only X's own "no such account" is a definite answer;
 * otherwise a failure is transient (`handleMiss`).
 */
export async function identifyHandle(
  handle: string,
  signal: AbortSignal,
  account: () => SessionCredential | undefined = () => undefined,
  {
    fetcher = fetch,
    endpoint = 'https://api.fxtwitter.com/2/profile',
    session = sessionAnswer,
  }: IdentifyOptions = {},
): Promise<string> {
  for (const spelled of new Set([handle, handle.toLowerCase()])) {
    const found = await publicAnswer(spelled, signal, fetcher, endpoint)
    if (typeof found === 'object') return found.id
  }
  const credential = account()
  if (!credential) throw handleMiss()
  const found = await session(handle, credential, signal)
  if (typeof found === 'object') return found.id
  if (found === 'none') {
    const error = new ProviderError(
      status.FAILED_PRECONDITION,
      '没有使用这个用户名的账号',
    )
    error.notFound = true
    throw error
  }
  throw handleMiss()
}
