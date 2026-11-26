import { createHash } from 'node:crypto'
import {
  FollowersByUserIDTimelineQuery,
  FollowersQuery,
  FollowingByUserIDTimelineQuery,
  FollowingQuery,
} from '@fxembed/atmosphere/providers/twitter/graphql/queries'
import {
  graphqlRequest,
  type GraphQLQuery,
} from '@fxembed/atmosphere/providers/twitter/graphql/request'
import {
  getFollowersFollowingInstructions,
  validateFollowersByUserIDTimelineResponse,
  validateFollowingByUserIDTimelineResponse,
  validateUserTweetsTimeline,
} from '@fxembed/atmosphere/providers/twitter/graphql/validators'
import { convertToApiUser } from '@fxembed/atmosphere/providers/twitter/profile'
import { processUserRelationshipTimelineInstructions } from '@fxembed/atmosphere/providers/twitter/search'
import {
  rateLimitedKey,
  type RelationList,
  type RelationsPage,
  type RelationsRequest,
} from '../platform.ts'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import { decodeCredential } from './credential.ts'
import { normalizeProfile } from './profile.ts'
import { ProviderError, readJSON, retrySeconds } from './provider.ts'
import { accountTransport, type TransactionSource } from './session.ts'
import type { FetchResponse } from '../protocol.ts'
import type { TwitterBuildHost } from '@fxembed/atmosphere/providers/twitter/build-host'

/** Accounts asked for per page; X may answer with fewer. */
export const relationPageSize = 100

/** Where public accounts' lists are read: the public FxTwitter instance. */
export const publicRelationsEndpoint = 'https://api.fxtwitter.com/2/profile'

const NUMERIC = /^\d+$/
// X keeps handing out a bottom cursor past the end; one starting with `0|`
// marks the end itself. FxTwitter passes X's cursors through.
const END_CURSOR = /^0\|/

interface ListQuery {
  query: GraphQLQuery
  validator: (response: unknown) => boolean
  variables: (userId: string) => Record<string, unknown>
}

/**
 * The two queries for each list. X limits each on its own: while one answers
 * 429 the other still answers. Both page through the same timeline and are
 * asked with each other's cursors: FxEmbed's own orchestrator picks one of
 * the two at random for every page and passes on the previous page's cursor.
 */
const LIST_QUERIES: Record<RelationList, ListQuery[]> = {
  followers: [
    {
      query: FollowersQuery,
      validator: validateUserTweetsTimeline,
      variables: (userId) => ({ userId }),
    },
    {
      query: FollowersByUserIDTimelineQuery,
      validator: validateFollowersByUserIDTimelineResponse,
      variables: (userId) => ({ rest_id: userId }),
    },
  ],
  following: [
    {
      query: FollowingQuery,
      validator: validateUserTweetsTimeline,
      variables: (userId) => ({ userId }),
    },
    {
      query: FollowingByUserIDTimelineQuery,
      validator: validateFollowingByUserIDTimelineResponse,
      variables: (userId) => ({ rest_id: userId }),
    },
  ],
}

/**
 * When each account's rate-limited queries reset (epoch ms), by
 * `<account hash>:<query name>`, so later pages ask the other query first.
 */
export type QueryLimits = Map<string, number>
const queryLimits: QueryLimits = new Map()

export interface RelationsDeps {
  fetcher?: typeof fetch
  transactions?: TransactionSource
  limits?: QueryLimits
  publicEndpoint?: string
}

/**
 * One page of an account's following or followers list. Each listed user
 * becomes the profile a profile fetch would make of it, from the list's user
 * data alone. A public account's lists come from the public FxTwitter
 * instance (`fxtwitter`), a protected one's from X with the account's
 * session (`x-session`).
 */
export async function listRelations(
  req: RelationsRequest,
  signal: AbortSignal,
  deps: RelationsDeps = {},
): Promise<RelationsPage> {
  if (!NUMERIC.test(req.externalId))
    throw new ProviderError(status.INVALID_ARGUMENT, '账号标识无效')
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  if (req.providerId === 'fxtwitter') return await listPublic(req, signal, deps)
  if (req.providerId === 'x-session')
    return await listSession(req, signal, deps)
  throw new ProviderError(status.INVALID_ARGUMENT, '采集来源无效')
}

function accounts(users: any[], req: RelationsRequest, provider: string) {
  const out = new Map<string, FetchResponse>()
  for (const user of users) {
    try {
      if (!NUMERIC.test(user?.id) || user.id === req.externalId) continue
      out.set(user.id, normalizeProfile(user, user.id, provider))
    } catch {
      // An entry without a valid profile has nothing to keep.
    }
  }
  return [...out.values()]
}

function nextCursor(listed: number, bottom: unknown, req: RelationsRequest) {
  // A page without users is past the end, whatever cursor it hands out.
  return listed &&
    typeof bottom === 'string' &&
    bottom &&
    bottom !== req.cursor &&
    !END_CURSOR.test(bottom)
    ? bottom
    : ''
}

/**
 * A page from the public FxTwitter instance. Every failure is transient
 * (UNAVAILABLE): it sometimes answers 500 or 404 for a page a retry then
 * returns. The job retries with backoff; its last error is the reason kept.
 */
async function listPublic(
  req: RelationsRequest,
  signal: AbortSignal,
  { fetcher = fetch, publicEndpoint = publicRelationsEndpoint }: RelationsDeps,
): Promise<RelationsPage> {
  const url = `${publicEndpoint}/id:${req.externalId}/${req.list}${
    req.cursor ? `?cursor=${encodeURIComponent(req.cursor)}` : ''
  }`
  const response = await upstream(fetcher, url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Monitor/0.4' },
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 429) {
      const error = new ProviderError(
        status.UNAVAILABLE,
        'FxTwitter 公共接口限流',
        retrySeconds(response.headers.get('retry-after')),
      )
      error.rateLimited = true
      error.metadata.set(rateLimitedKey, '1')
      throw error
    }
    throw new ProviderError(
      status.UNAVAILABLE,
      `FxTwitter 公共接口返回 HTTP ${response.status}`,
    )
  }
  const data = await readJSON(response).catch(() => {
    throw new ProviderError(
      status.UNAVAILABLE,
      'FxTwitter 公共接口返回的数据无效',
    )
  })
  if (data?.code !== 200 || !Array.isArray(data.results))
    throw new ProviderError(
      status.UNAVAILABLE,
      `FxTwitter 公共接口返回错误（code ${typeof data?.code === 'number' ? data.code : '无'}）`,
    )
  return {
    accounts: accounts(data.results, req, 'fxtwitter'),
    nextCursor: nextCursor(data.results.length, data.cursor?.bottom, req),
  }
}

/**
 * A page read with the account's session. Of the list's two queries, the
 * first not known to be rate-limited is asked; a 429 moves the same page on
 * to the other. When both are limited, the failure says to wait for the
 * earlier reset (`rateLimitedKey`).
 */
async function listSession(
  req: RelationsRequest,
  signal: AbortSignal,
  { fetcher = fetch, transactions, limits = queryLimits }: RelationsDeps,
): Promise<RelationsPage> {
  if (!req.credential)
    throw new ProviderError(status.INVALID_ARGUMENT, '需要采集账号')
  const credential = decodeCredential(req.credential)
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, {
      target: 'list',
      fetcher,
      transactions,
    }),
    shouldTranscodeGif: () => false,
  }
  const account = createHash('sha256')
    .update(credential.authToken)
    .digest('hex')
    .slice(0, 16)
  const key = (q: ListQuery) => `${account}:${q.query.queryName}`
  const limitedUntil = (q: ListQuery) => limits.get(key(q)) ?? 0
  const queries = LIST_QUERIES[req.list]
  const now = Date.now()
  for (const [k, until] of limits) if (until <= now) limits.delete(k)
  // Queries still limited from earlier pages go last (a stable sort).
  const order = queries.toSorted(
    (a, b) => Number(limitedUntil(a) > now) - Number(limitedUntil(b) > now),
  )
  let data: unknown
  let limited: ProviderError | undefined
  let previous: ListQuery | undefined
  for (const q of order) {
    if (limitedUntil(q) > Date.now()) {
      previous = q
      continue
    }
    if (previous && limited)
      req.logger.info(
        {
          list: req.list,
          from: previous.query.queryName,
          to: q.query.queryName,
          cursor: req.cursor ? 'page' : 'first',
        },
        'relations query rate-limited; switching to the other query',
      )
    try {
      data = await graphqlRequest(host, {
        query: q.query,
        validator: q.validator,
        variables: {
          ...q.variables(req.externalId),
          count: relationPageSize,
          cursor: req.cursor || null,
        },
      })
      limits.delete(key(q))
      break
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw new ProviderError(status.UNAVAILABLE, '平台返回的关注列表无效')
      }
      if (!error.rateLimited) throw error
      const seconds = Number(error.metadata.get('retry-after')[0] ?? 0)
      if (seconds > 0) limits.set(key(q), Date.now() + seconds * 1000)
      limited = error
      previous = q
    }
  }
  if (data === undefined) {
    const resets = queries.map(limitedUntil)
    const wait = Math.ceil((Math.min(...resets) - Date.now()) / 1000)
    // Without a reset for each, the last 429 stands as an ordinary failure.
    if (resets.some((until) => !(until > Date.now())) || wait <= 0)
      throw limited ?? new ProviderError(status.UNAVAILABLE, '来源平台限流')
    req.logger.info(
      { list: req.list, waitSeconds: wait },
      'both relations queries rate-limited; waiting for the earlier reset',
    )
    const error = new ProviderError(
      status.UNAVAILABLE,
      '关注列表的两个 X 接口均已限流',
      wait,
    )
    error.rateLimited = true
    error.metadata.set(rateLimitedKey, '1')
    throw error
  }
  const instructions = getFollowersFollowingInstructions(data, req.list) ?? []
  const { users, cursors } =
    processUserRelationshipTimelineInstructions(instructions)
  const profiles = users.flatMap((user) => {
    try {
      return [convertToApiUser(user, false)]
    } catch {
      // A suspended or withheld entry has no profile to keep.
      return []
    }
  })
  return {
    accounts: accounts(profiles, req, 'x-session'),
    nextCursor: nextCursor(
      users.length,
      cursors.find((c) => c.cursorType === 'Bottom')?.value,
      req,
    ),
  }
}
