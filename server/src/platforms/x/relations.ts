import {
  FollowersQuery,
  FollowingQuery,
} from '@fxembed/atmosphere/providers/twitter/graphql/queries'
import { graphqlRequest } from '@fxembed/atmosphere/providers/twitter/graphql/request'
import {
  getFollowersFollowingInstructions,
  validateUserTweetsTimeline,
} from '@fxembed/atmosphere/providers/twitter/graphql/validators'
import { convertToApiUser } from '@fxembed/atmosphere/providers/twitter/profile'
import { processUserRelationshipTimelineInstructions } from '@fxembed/atmosphere/providers/twitter/search'
import { status } from '../rpc.ts'
import { decodeCredential } from './credential.ts'
import { normalizeProfile } from './profile.ts'
import { ProviderError } from './provider.ts'
import { accountTransport } from './session.ts'
import type { RelationsPage, RelationsRequest } from '../platform.ts'
import type { FetchResponse } from '../protocol.ts'
import type { TwitterBuildHost } from '@fxembed/atmosphere/providers/twitter/build-host'

/** Accounts asked for per page; X may answer with fewer. */
export const relationPageSize = 100

const NUMERIC = /^\d+$/
// X keeps handing out a bottom cursor past the end; one starting with `0|`
// marks the end itself.
const END_CURSOR = /^0\|/

/**
 * One page of an account's following or followers list, read with the
 * account's session. Each listed user becomes the profile a profile fetch
 * would make of it, from the list's user data alone.
 */
export async function listRelations(
  req: RelationsRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RelationsPage> {
  if (!NUMERIC.test(req.externalId))
    throw new ProviderError(status.INVALID_ARGUMENT, '账号标识无效')
  const credential = decodeCredential(req.credential)
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, fetcher),
    shouldTranscodeGif: () => false,
  }
  let data: unknown
  try {
    // One query only: the orchestrator's fallbacks would hide a rate limit
    // behind a second request that meets the same limit.
    data = await graphqlRequest(host, {
      query: req.list === 'following' ? FollowingQuery : FollowersQuery,
      validator: validateUserTweetsTimeline,
      variables: {
        userId: req.externalId,
        count: relationPageSize,
        cursor: req.cursor || null,
      },
    })
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(status.UNAVAILABLE, '平台返回的关注列表无效')
  }
  const instructions = getFollowersFollowingInstructions(data, req.list) ?? []
  const { users, cursors } =
    processUserRelationshipTimelineInstructions(instructions)
  const accounts = new Map<string, FetchResponse>()
  for (const user of users) {
    try {
      const profile = convertToApiUser(user, false)
      if (!NUMERIC.test(profile.id) || profile.id === req.externalId) continue
      accounts.set(
        profile.id,
        normalizeProfile(profile, profile.id, 'x-session'),
      )
    } catch {
      // A suspended or withheld entry has no profile to keep.
    }
  }
  const bottom = cursors.find((c) => c.cursorType === 'Bottom')?.value ?? ''
  return {
    accounts: [...accounts.values()],
    // A page without users is past the end, whatever cursor it hands out.
    nextCursor:
      users.length &&
      bottom &&
      bottom !== req.cursor &&
      !END_CURSOR.test(bottom)
        ? bottom
        : '',
  }
}
