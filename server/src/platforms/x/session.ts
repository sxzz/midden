import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  getTwitterProviderEnv,
  setTwitterProviderEnv,
} from '@fxembed/atmosphere/providers/twitter-runtime'
import { fetchByRestId } from '@fxembed/atmosphere/providers/twitter/conversation'
import {
  buildAPITwitterStatus,
  twitterTweetTombstoneFromGraphQL,
} from '@fxembed/atmosphere/providers/twitter/processor'
import { needsTransactionId } from '@fxembed/atmosphere/providers/twitter/proxy/allowlist'
import { ClientTransaction } from '@fxembed/atmosphere/providers/twitter/proxy/transaction/transaction'
import { Visibility, type SourceResponse } from '../protocol.ts'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { accountBootstrap, accountUserAgent } from './bootstrap.ts'
import { validateCredential, type SessionCredential } from './credential.ts'
import {
  asRepost,
  normalize,
  profileRef,
  ProviderError,
  readJSON,
  responseError,
  sourceStateExplicitKey,
  sourceStateKey,
  type ErrorTarget,
} from './provider.ts'
import type { TwitterBuildHost } from '@fxembed/atmosphere/providers/twitter/build-host'
export { validateCredential } from './credential.ts'

// Public application token from pinned upstream src/constants.ts; not an account secret.
// Configures Atmosphere once, before any request is built.
// eslint-disable-next-line unicorn/no-top-level-side-effects
setTwitterProviderEnv({
  guestBearerToken:
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  friendlyUserAgent: 'Monitor/0.4',
})

/** Signs a request the way x.com's own client does. */
export interface TransactionSigner {
  generateTransactionId: (method: string, path: string) => Promise<string>
}
export type TransactionSource = (
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch,
) => Promise<TransactionSigner>

// GraphQL queries X refuses (404) without `x-client-transaction-id`, besides
// the ones Atmosphere lists. `Following` still works without it, but x.com's
// own client signs it as it does `Followers`. The `*ByUserIDTimeline` queries
// work without it and stay unsigned.
const SIGNED_QUERIES = new Set(['Followers', 'Following'])

function needsSigning(url: URL): boolean {
  if (needsTransactionId(url.href)) return true
  const graphql = /\/graphql\/[^/]+\/(\w+)$/.exec(url.pathname)
  return !!graphql && SIGNED_QUERIES.has(graphql[1]!)
}

// The signer comes from the account's own x.com page; a list fetch signs a
// request per page, so the page is read again only after this long.
const SIGNER_TTL = 10 * 60_000
const signers = new Map<
  string,
  { at: number; value: Promise<TransactionSigner> }
>()

/** The account's transaction signer, from its x.com page, kept a while. */
export const accountTransactions: TransactionSource = (
  credential,
  signal,
  fetcher,
) => {
  const key = createHash('sha256').update(credential.authToken).digest('hex')
  const now = Date.now()
  const cached = signers.get(key)
  if (cached && now - cached.at < SIGNER_TTL) return cached.value
  for (const [k, entry] of signers)
    if (now - entry.at >= SIGNER_TTL) signers.delete(k)
  const value = accountBootstrap(credential, signal, fetcher).then(
    ({ html }): Promise<TransactionSigner> => ClientTransaction.fromHTML(html),
  )
  signers.set(key, { at: now, value })
  value.catch(() => {
    if (signers.get(key)?.value === value) signers.delete(key)
  })
  return value
}

export interface TransportOptions {
  /** What the requests are for, which decides the wording of failures. */
  target: ErrorTarget
  fetcher?: typeof fetch
  /** Collects the raw responses, as private sources. */
  responses?: SourceResponse[]
  transactions?: TransactionSource
}

export function accountTransport(
  credential: SessionCredential,
  signal: AbortSignal,
  {
    target,
    fetcher = fetch,
    responses,
    transactions = accountTransactions,
  }: TransportOptions,
): TwitterBuildHost['twitterProxy'] {
  validateCredential(credential)
  let transaction: Promise<TransactionSigner> | undefined
  return {
    fetch: async (input, init = {}) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      )
      if (
        !['api.x.com', 'api.twitter.com', 'x.com', 'twitter.com'].includes(
          url.hostname,
        )
      )
        throw new ProviderError(status.FAILED_PRECONDITION, '不支持的账号接口')
      const headers = new Headers(init.headers)
      headers.set('user-agent', accountUserAgent)
      headers.set('referer', 'https://x.com/')
      headers.set('origin', 'https://x.com')
      headers.set('accept', 'application/json')
      headers.set('authorization', getTwitterProviderEnv().guestBearerToken)
      headers.set(
        'cookie',
        `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      )
      headers.set('x-csrf-token', credential.csrfToken)
      headers.set('x-twitter-auth-type', 'OAuth2Session')
      headers.set('x-twitter-active-user', 'yes')
      headers.delete('x-guest-token')
      headers.delete('x-client-transaction-id')
      if (needsSigning(url)) {
        transaction ??= transactions(credential, signal, fetcher)
        let generator: TransactionSigner
        try {
          generator = await transaction
        } catch (e) {
          if (e instanceof ProviderError) throw e
          throw new ProviderError(status.UNAVAILABLE, '采集账号请求签名不可用')
        }
        headers.set(
          'x-client-transaction-id',
          await generator.generateTransactionId(
            init.method ?? 'GET',
            url.pathname,
          ),
        )
      }
      const response = await upstream(fetcher, url, {
        ...init,
        headers,
        signal,
        redirect: 'error',
      })
      if (response.headers.get('cf-mitigated') === 'challenge') {
        await response.body?.cancel()
        throw new ProviderError(
          status.UNAVAILABLE,
          'X 要求浏览器验证，无法确认账号是否有效',
        )
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw responseError(
          response.status,
          response.status === 429
            ? retryHeader(response)
            : response.headers.get('retry-after'),
          // X's endpoints answer 404 for a refused request, never for a
          // missing post or account.
          response.status === 404 ? 'api' : target,
        )
      }
      const data = await readJSON(response, (body) => {
        if (!responses) {
          return
        }

        if (
          responses.reduce((n, r) => n + r.body.length, 0) + body.length >
          4 << 20
        )
          throw new ProviderError(status.RESOURCE_EXHAUSTED, '原始响应超出上限')
        responses.push({
          body: Buffer.from(body),
          contentType:
            response.headers.get('content-type') ?? 'application/json',
          sourceUrl: url.href,
          visibility: Visibility.VISIBILITY_PRIVATE,
        })
      })
      if (Array.isArray(data.errors) && data.errors.length) {
        const codes = data.errors.map((e: any) => e.code)
        const error = codes.some((c: number) =>
          [32, 89, 135, 215, 326].includes(c),
        )
          ? responseError(401, null, target)
          : codes.includes(88)
            ? responseError(429, retryHeader(response), target)
            : codes.some((c: number) => [63, 179, 200].includes(c))
              ? responseError(403, null, target)
              : new ProviderError(status.UNAVAILABLE, '账号接口返回错误')
        error.details.graphqlErrors = codes
        throw error
      }
      return Response.json(data)
    },
  }
}
/**
 * When to ask again after a rate limit. X names the end of the limit's
 * window (`x-rate-limit-reset`, epoch seconds) rather than `retry-after`.
 */
function retryHeader(response: Response): string | null {
  const retry = response.headers.get('retry-after')
  if (retry) return retry
  const reset = Number(response.headers.get('x-rate-limit-reset'))
  if (!Number.isFinite(reset) || reset <= 0) return null
  return String(Math.max(1, Math.ceil(reset - Date.now() / 1000)))
}
// Public classification requires positive evidence for every included author.
/**
 * Who may read a post, from its raw node. The author's protection decides,
 * unless the post itself reaches fewer people (subscribers only, a circle, a
 * community, or a limit X does not explain). Quoted and reposted posts do not
 * count: they are kept by reference only.
 */
export function rawVisibility(node: any): {
  visibility: Visibility
  /** The author's ID, when the node names one. */
  author?: string
  /** The author is known to be public. */
  authorPublic: boolean
  /** Private only because this author is protected. */
  subject?: string
} {
  if (!node || typeof node !== 'object')
    return { visibility: Visibility.VISIBILITY_PRIVATE, authorPublic: false }
  let narrowed = false
  let tweet = node
  // A sensitive-media blur changes presentation, not who may read the post.
  // Unknown wrapper/visibility fields still require private storage.
  if (node.__typename === 'TweetWithVisibilityResults') {
    const media = node.mediaVisibilityResults
    narrowed =
      Object.keys(node).some(
        (key) =>
          !['__typename', 'tweet', 'mediaVisibilityResults'].includes(key),
      ) ||
      (media != null &&
        (typeof media !== 'object' ||
          Array.isArray(media) ||
          Object.keys(media).some(
            (key) => key !== 'blurred_image_interstitial',
          )))
    tweet = node.tweet
  }
  const root = tweet?.tweet ?? tweet?.result ?? tweet
  const user =
    root?.core?.user_results?.result ?? root?.core?.user_result?.result
  const author =
    typeof user?.rest_id === 'string' && /^\d+$/.test(user.rest_id)
      ? user.rest_id
      : undefined
  const protectedFlag = user?.privacy?.protected ?? user?.legacy?.protected
  const walk = (value: any): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (
        value === root &&
        (key === 'core' ||
          /^quoted_(?:status_result|tweet_results)$/.test(key) ||
          /^retweeted_status_results?$/.test(key))
      )
        continue
      if (key === 'legacy' && value === root) {
        const { retweeted_status_result, ...rest } = child as any
        walk(rest)
        continue
      }
      if (
        child &&
        /trusted_friends|exclusive_tweet|limited_?actions?|tombstone|interstitial|audience|community_results/i.test(
          key,
        )
      )
        narrowed = true
      if (key === 'protected' && child !== false) narrowed = true
      if (typeof child === 'object') walk(child)
    }
  }
  walk(root)
  const authorPublic = protectedFlag === false
  return {
    visibility:
      authorPublic && !narrowed
        ? Visibility.VISIBILITY_PUBLIC
        : Visibility.VISIBILITY_PRIVATE,
    author,
    authorPublic,
    subject: protectedFlag === true && !narrowed ? author : undefined,
  }
}
function unavailable(node: any): boolean {
  return (
    !node ||
    typeof node !== 'object' ||
    node.__typename === 'TweetUnavailable' ||
    node.__typename === 'TweetTombstone'
  )
}
function unwrapTweet(node: any): any {
  const value = node?.result ?? node
  return value?.__typename === 'TweetWithVisibilityResults'
    ? value.tweet
    : value
}
/**
 * What the account was told of a post it cannot read, when X says why: a
 * tombstone's text or an unavailable post's reason. Being the account's own
 * view, it needs no second answer.
 */
export function unavailableState(
  node: any,
): 'deleted' | 'suspended' | undefined {
  if (node?.__typename === 'TweetUnavailable') {
    const reason = String(node.reason ?? '')
    if (/suspend/i.test(reason)) return 'suspended'
    if (/delete/i.test(reason)) return 'deleted'
    return
  }
  if (node?.__typename !== 'TweetTombstone') return
  const { reason } = twitterTweetTombstoneFromGraphQL(node) as {
    reason?: string
  }
  return reason === 'deleted' || reason === 'suspended' ? reason : undefined
}
async function sessionTweet(id: string, host: TwitterBuildHost): Promise<any> {
  const data = await fetchByRestId(id, host, true)
  const raw = data?.data?.tweetResult?.result
  if (unavailable(raw) || unavailable(unwrapTweet(raw))) {
    const state = unavailableState(raw) ?? unavailableState(unwrapTweet(raw))
    if (!state) throw responseError(403, null, 'post')
    const error =
      state === 'suspended'
        ? responseError(404, null, 'post', 'suspended')
        : new ProviderError(status.FAILED_PRECONDITION, '原帖已删除')
    error.metadata.set(sourceStateKey, state)
    error.metadata.set(sourceStateExplicitKey, '1')
    throw error
  }
  return raw
}
export async function fetchSession(
  id: string,
  credential: SessionCredential,
  signal: AbortSignal,
) {
  const responses: SourceResponse[] = []
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, {
      target: 'post',
      responses,
    }),
    shouldTranscodeGif: () => false,
  }
  const raw = await sessionTweet(id, host)
  // A repost's link carries the reposted post, which is what is saved.
  const reposted = unwrapTweet(raw)?.legacy?.retweeted_status_result?.result
  const original = (reposted?.tweet ?? reposted)?.rest_id
  const result = await parseSessionResult(
    reposted && original ? original : id,
    reposted && original ? reposted : raw,
    host,
  )
  result.sourceResponses = responses
  return reposted && original && original !== id ? asRepost(result, id) : result
}
export async function parseSessionResult(
  id: string,
  raw: any,
  host: TwitterBuildHost,
) {
  // Evaluate before Atmosphere normalizes (and mutates) the raw nodes.
  const seen = rawVisibility(raw)
  const editSource = structuredClone(raw)
  const post = await buildAPITwitterStatus(
    host,
    raw,
    undefined,
    null,
    false,
    false,
    'root',
    id,
  )
  const result = normalize(post, id, 'x-session', seen.visibility, editSource)
  if (seen.subject) result.privateSubject = profileRef(seen.subject)
  if (seen.authorPublic && seen.author)
    result.publicSubjects.push(profileRef(seen.author))
  if (raw?.mediaVisibilityResults?.blurred_image_interstitial) {
    for (const resource of result.resources) resource.sensitive = true
  }
  return result
}
export async function checkSession(
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  validateCredential(credential)
  // Viewer identifies the authenticated session itself, not a caller-supplied
  // user ID or the author of a publicly readable post.
  const url = new URL('https://api.x.com/graphql/9t128XgFic52jPUEkJMf6w/Viewer')
  url.searchParams.set(
    'variables',
    JSON.stringify({
      withCommunitiesMemberships: true,
      withSubscribedTab: true,
      withCommunitiesCreation: true,
    }),
  )
  url.searchParams.set(
    'features',
    JSON.stringify({
      subscriptions_upsells_api_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: true,
      rweb_tipjar_consumption_enabled: false,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }),
  )
  const transport = accountTransport(credential, signal, {
    target: 'api',
    fetcher,
  })!
  const response = await transport.fetch(url)
  const data = await readJSON(response)
  const viewer = data?.data?.viewer
  if (viewer?.is_tfe_restricted_session === true)
    throw new ProviderError(status.PERMISSION_DENIED, 'X 账号受限')
  const user = viewer?.user_results?.result
  const accountId = user?.rest_id
  const username = user?.core?.screen_name
  if (
    user?.__typename !== 'User' ||
    typeof accountId !== 'string' ||
    !/^\d+$/.test(accountId) ||
    typeof username !== 'string' ||
    !/^\w{1,50}$/.test(username)
  )
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      '账号验证响应格式已变化',
    )
  return { accountId, username }
}
