import { Buffer } from 'node:buffer'
import { isTombstone } from '@fxembed/atmosphere/helpers/tombstone'
import { graphQLOrchestrator } from '@fxembed/atmosphere/providers/twitter/graphql/orchestrator'
import { UserTweetsQuery } from '@fxembed/atmosphere/providers/twitter/graphql/queries'
import {
  getProfileStatusesTimelineInstructions,
  validateUserTweetsTimeline,
} from '@fxembed/atmosphere/providers/twitter/graphql/validators'
import { buildAPITwitterStatus } from '@fxembed/atmosphere/providers/twitter/processor'
import { processTimelineInstructions } from '@fxembed/atmosphere/providers/twitter/search'
import { pastCutoff, recordPinnedPosts } from '../listing.ts'
import {
  FetchResponse,
  RelatedTarget,
  Visibility,
  type SourceResponse,
} from '../protocol.ts'
import { status } from '../rpc.ts'
import { upstream } from '../upstream.ts'
import {
  addRelation,
  attachEntities,
  attachMentions,
  attachProfileReference,
  postUpdatedAt,
} from './entities.ts'
import {
  profileRef,
  ProviderError,
  readJSON,
  responseError,
  upstreamError,
} from './provider.ts'
import { accountTransport } from './session.ts'
import type { SessionCredential } from './credential.ts'
import type { TwitterBuildHost } from '@fxembed/atmosphere/providers/twitter/build-host'

/**
 * What a timeline showed of one listed post. The core hands it back to the
 * capture of that post, which then needs no request of its own.
 */
export type Prefetch =
  | { source: 'fxtwitter'; observed_at: string; source_url: string; post: any }
  | { source: 'x-session'; observed_at: string; source_url: string; node: any }
export function encodePrefetch(value: Prefetch): Buffer | undefined {
  const body = Buffer.from(JSON.stringify(value))
  return body.length <= 64 << 10 ? body : undefined
}
export function decodePrefetch(body: Uint8Array): Prefetch | undefined {
  if (!body.length) return
  try {
    const value = JSON.parse(Buffer.from(body).toString())
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return
  }
}
// The listing carries only a stub of an article and says who reposted a post
// into the timeline, which the post's own response never does.
function publicPrefetch(post: any, sourceUrl: string): Buffer | undefined {
  if (post.article) return
  return encodePrefetch({
    source: 'fxtwitter',
    observed_at: new Date().toISOString(),
    source_url: sourceUrl,
    post: { ...post, reposted_by: null },
  })
}

export function normalizeProfile(
  user: any,
  requested: string,
  provider: string,
): FetchResponse {
  if (
    user?.type !== 'profile' ||
    typeof user.id !== 'string' ||
    !/^\d+$/.test(user.id) ||
    typeof user.screen_name !== 'string' ||
    typeof user.name !== 'string' ||
    (!requested.startsWith('handle:') && requested !== user.id)
  )
    throw new ProviderError(status.UNAVAILABLE, '平台返回的账号资料无效')
  const result = FetchResponse.fromPartial({
    externalId: requested,
    providerId: provider,
    adapterVersion: '0.4.0',
    textKind: 'profile',
    textSource: provider,
    visibility:
      provider === 'fxtwitter' || user.protected === false
        ? Visibility.VISIBILITY_PUBLIC
        : Visibility.VISIBILITY_PRIVATE,
    text: [`@${user.screen_name}`, user.description || '']
      .filter(Boolean)
      .join('\n'),
    summary: `${user.name || user.screen_name}：${user.description || `@${user.screen_name}`}`,
    canonicalTarget: {
      url: `https://x.com/i/user/${user.id}`,
      externalId: user.id,
      platform: 'x',
      kind: 'profile',
      refreshOnSubmit: true,
      collection: true,
    },
    publicSubjects: user.protected === false ? [profileRef(user.id)] : [],
  })
  // Reuse the public field projection; account-view fields remain exclusively in private raw responses.
  attachEntities(result, { author: user })
  result.graph!.root = 'author'
  result.graph!.entities = result.graph!.entities.filter(
    (e) => e.key === 'author',
  )
  result.graph!.relations = []
  result.relatedTargets = []
  const entity = result.graph!.entities[0]
  entity.contextOnly = false
  const data = JSON.parse(Buffer.from(entity.dataJson).toString())
  if (provider === 'fxtwitter') data.metadata = user
  for (const key of ['raw_description', 'birthday', 'about_account']) {
    // Public API fields are retained completely; the original account response is private.
    if (provider === 'fxtwitter' && user[key] !== undefined)
      data.metadata[key] = user[key]
  }
  entity.dataJson = Buffer.from(JSON.stringify(data))
  if (typeof user.banner_url === 'string' && user.banner_url) {
    entity.resourceIndices.push(result.resources.length)
    result.resources.push({
      url: user.banner_url,
      kind: 'image',
      purpose: 'banner',
      immutableKey: `x:banner:${user.banner_url}`,
      altText: '',
      sensitive: false,
    })
  }
  attachMentions(
    result,
    'author',
    user.description,
    user.raw_description?.facets,
  )
  return result
}

/** When and how a post sits on the timeline, if the source says more. */
export interface Listing {
  listedAt?: string
  pinned?: boolean
}

/**
 * The public API lists a repost as the original post, with its publication
 * time; when it was reposted is not given. Nor does it mark the pinned post,
 * which comes first on a page (on every page past the timeline's end), so
 * the first entry of each page may be pinned.
 */
function publicListing(post: any, publishedAt: string, index: number): Listing {
  return {
    listedAt: post.reposted_by ? '' : publishedAt,
    pinned: index === 0,
  }
}

export function attachTimeline(
  result: FetchResponse,
  timeline: any,
  prefetch?: (post: any) => Buffer | undefined,
  listing?: (post: any) => Listing | undefined,
): void {
  if (timeline?.code !== 200 || !Array.isArray(timeline.results))
    throw new ProviderError(status.UNAVAILABLE, '平台返回的时间线无效')
  const ids = new Map<string, RelatedTarget>()
  for (const [index, post] of (timeline.results as any[]).entries()) {
    if (
      post?.type === 'status' &&
      typeof post.id === 'string' &&
      /^\d+$/.test(post.id)
    ) {
      const publishedAt = Number.isFinite(Date.parse(post.created_at))
        ? new Date(post.created_at).toISOString()
        : typeof post.created_timestamp === 'number'
          ? new Date(post.created_timestamp * 1000).toISOString()
          : ''
      const listed = listing
        ? listing(post)
        : publicListing(post, publishedAt, index)
      // A post listed twice keeps the first place; pinned there, it stays so.
      const pinned = !!listed?.pinned || !!ids.get(post.id)?.pinned
      ids.set(
        post.id,
        RelatedTarget.fromPartial({
          url: `https://x.com/i/web/status/${post.id}`,
          updatedAt: postUpdatedAt(post),
          publishedAt,
          listedAt: listed?.listedAt ?? '',
          pinned,
          mediaTypes: [
            ...new Set<string>(
              (
                post.media?.all ?? [
                  ...(post.media?.photos ?? []),
                  ...(post.media?.videos ?? []),
                ]
              )
                .map((media: any) =>
                  media.type === 'photo'
                    ? 'image'
                    : media.type === 'video' || media.type === 'gif'
                      ? 'video'
                      : '',
                )
                .filter(Boolean),
            ),
          ],
          postType: post.reposted_by ? 'repost' : post.quote ? 'quote' : 'post',
          prefetch: prefetch?.(post),
        }),
      )
      if (result.graph && post.reposted_by?.id) {
        const profile = attachProfileReference(result, post.reposted_by)
        let entity = result.graph.entities.find(
          (item) => item.type === 'x.post' && item.externalId === post.id,
        )
        if (!entity) {
          entity = {
            key: `timeline_${post.id}`,
            type: 'x.post',
            externalId: post.id,
            contextOnly: true,
            dataJson: Buffer.from(
              JSON.stringify({
                text: typeof post.text === 'string' ? post.text : '',
              }),
            ),
            resourceIndices: [],
          }
          result.graph.entities.push(entity)
        }
        if (profile) addRelation(result, profile, entity.key, 'reposted')
      }
    }
  }
  if (ids.size > 200)
    throw new ProviderError(status.RESOURCE_EXHAUSTED, '时间线超出单次翻页上限')
  result.nextPageCursor =
    ids.size && typeof timeline.cursor?.bottom === 'string'
      ? timeline.cursor.bottom
      : ''
  const targets = new Map(
    result.relatedTargets.map((target) => [target.url, target]),
  )
  for (const target of ids.values()) targets.set(target.url, target)
  result.relatedTargets = [...targets.values()]
}

async function publicJSON(
  url: string,
  signal: AbortSignal,
  responses: SourceResponse[],
  fetcher: typeof fetch = fetch,
): Promise<any> {
  const response = await upstream(fetcher, url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Monitor/0.4' },
  })
  if (!response.ok) throw await upstreamError(response, 'profile')
  const data = await readJSON(response, (body) =>
    responses.push({
      body,
      contentType: response.headers.get('content-type') ?? 'application/json',
      sourceUrl: url,
      visibility: Visibility.VISIBILITY_PUBLIC,
    }),
  )
  if (data?.code !== 200)
    throw responseError(
      typeof data?.code === 'number' ? data.code : 502,
      null,
      'profile',
      data?.reason,
    )
  return data
}
// A capture targets about 100 posts, five or six pages. The bound only stops
// a source that keeps handing out cursors from spending the account's quota.
export const maxTimelinePages = 15

// Keep whole upstream pages: the requested size is a target, never a truncation boundary.
export async function collectTimeline(
  result: FetchResponse,
  fetchPage: (cursor: string) => Promise<{
    timeline: any
    prefetch?: (post: any) => Buffer | undefined
    listing?: (post: any) => Listing | undefined
  }>,
  cursor = '',
  pageSize = 0,
  since = '',
): Promise<void> {
  const target = Math.min(pageSize || 100, 100)
  const targets = new Map(result.relatedTargets.map((t) => [t.url, t]))
  const visited = new Set<string>()
  result.nextPageCursor = cursor
  let posts = 0
  while (posts < target) {
    if (visited.has(cursor)) {
      result.nextPageCursor = ''
      break
    }
    if (visited.size >= maxTimelinePages) {
      result.incomplete = true
      result.warnings.push('已达单次翻页上限。')
      break
    }
    visited.add(cursor)
    const page = FetchResponse.fromPartial({ graph: result.graph })
    // Advance the checkpoint only after successfully parsing the entire page.
    const { timeline, prefetch, listing } = await fetchPage(cursor)
    attachTimeline(page, timeline, prefetch, listing)
    for (const item of page.relatedTargets) targets.set(item.url, item)
    result.graph = page.graph
    result.relatedTargets = [...targets.values()]
    const before = posts
    posts = result.relatedTargets.filter((item) =>
      item.url.includes('/status/'),
    ).length
    const next = page.nextPageCursor
    // Past its end, UserTweets keeps returning a fresh cursor with only the
    // pinned post. A page without a new post is the end of the timeline.
    result.nextPageCursor = visited.has(next) || posts === before ? '' : next
    if (!result.nextPageCursor) break
    // Past the date cutoff the rest is older still; the cursor stays, so a
    // later read can go on from here.
    if (since && pastCutoff(page.relatedTargets, since)) break
    cursor = result.nextPageCursor
  }
}

export async function fetchPublicTimeline(
  result: FetchResponse,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  cursor = '',
  pageSize = 0,
  since = '',
): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  try {
    await collectTimeline(
      result,
      async (next) => {
        const url = `https://api.fxtwitter.com/2/profile/id:${result.canonicalTarget!.externalId}/statuses?count=${Math.min(pageSize || 100, 100)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`
        const timeline = await publicJSON(
          url,
          signal,
          result.sourceResponses,
          fetcher,
        )
        return {
          timeline,
          prefetch: (post: any) => publicPrefetch(post, url),
        }
      },
      cursor,
      pageSize,
      since,
    )
  } catch {
    result.incomplete = true
    result.warnings.push('帖子获取中断。')
  }
}

export async function fetchPublicProfile(
  id: string,
  expand: boolean,
  signal: AbortSignal,
  endpoint = 'https://api.fxtwitter.com/2/profile',
  fetcher: typeof fetch = fetch,
): Promise<FetchResponse> {
  const responses: SourceResponse[] = []
  const get = (url: string) => publicJSON(url, signal, responses, fetcher)
  const handle = id.startsWith('handle:') ? id.slice(7) : `id:${id}`
  const data = await get(
    `${endpoint}/${encodeURIComponent(handle)}?about_account=1`,
  )
  const result = normalizeProfile(data.user, id, 'fxtwitter')
  if (expand) {
    try {
      attachTimeline(
        result,
        await get(`${endpoint}/id:${data.user.id}/statuses?count=100`),
      )
    } catch {
      result.incomplete = true
      result.warnings.push('帖子获取中断。')
    }
  }
  result.sourceResponses = responses
  return result
}

// The raw node of a post, which an account's single-post response would carry
// too; a repost lists the reposted post's node. A public author's post is read
// from the public API like any public post, so it gets no prefetch here.
function sessionPrefetch(node: any, sourceUrl: string): Buffer | undefined {
  const author = (node?.tweet ?? node)?.core?.user_results?.result
  if ((author?.privacy?.protected ?? author?.legacy?.protected) !== true) return
  return encodePrefetch({
    source: 'x-session',
    observed_at: new Date().toISOString(),
    source_url: sourceUrl,
    node,
  })
}
interface TimelineNode {
  node: any
  /** Listed by a `TimelinePinEntry` instruction. */
  pinned: boolean
  promoted: boolean
}
function timelineNodes(instructions: any[]): TimelineNode[] {
  const nodes: TimelineNode[] = []
  const visit = (content: any, pinned: boolean) => {
    const item = content?.itemContent ?? content?.content ?? content
    if (item?.__typename === 'TimelineTweet' && item.tweet_results?.result)
      nodes.push({
        node: item.tweet_results.result,
        pinned,
        promoted: !!item.promotedMetadata,
      })
  }
  for (const instruction of instructions) {
    const pinned =
      (instruction?.type ?? instruction?.__typename) === 'TimelinePinEntry'
    for (const entry of instruction?.entries ??
      (instruction?.entry ? [instruction.entry] : [])) {
      visit(entry?.content, pinned)
      for (const item of entry?.content?.items ?? []) visit(item?.item, pinned)
    }
  }
  return nodes
}
function isoTime(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}
// UserTweets lists posts in the same shape as the single-post response, so the
// raw nodes can stand in for it. ProfileTimeline uses another shape.
async function sessionTimelinePage(
  userId: string,
  count: number,
  cursor: string | null,
  host: TwitterBuildHost,
) {
  const response = await graphQLOrchestrator(host, [
    {
      key: 'tweets',
      required: true,
      methods: [
        {
          name: 'UserTweets',
          query: UserTweetsQuery,
          weight: 1,
          validator: validateUserTweetsTimeline,
        },
      ],
      variables: { userId, count, cursor },
    },
  ])
  if (!response.tweets?.success)
    throw new ProviderError(status.UNAVAILABLE, '平台返回的时间线无效')
  const instructions =
    getProfileStatusesTimelineInstructions(response.tweets.data) ?? []
  const results: any[] = []
  const nodes = new Map<string, any>()
  const listings = new Map<string, Listing>()
  // Read off the instruction, even when the post itself cannot be built.
  const pins: string[] = []
  for (const { node, pinned, promoted } of timelineNodes(instructions)) {
    const tweet = node.tweet ?? node
    if (pinned && /^\d+$/.test(tweet.rest_id ?? '')) pins.push(tweet.rest_id)
    const status: any = await buildAPITwitterStatus(
      host,
      tweet,
      undefined,
      null,
      false,
      false,
    ).catch(() => null)
    if (!status || isTombstone(status) || status.status) continue
    const original = tweet.legacy?.retweeted_status_result?.result ?? node
    if ((original.tweet ?? original).rest_id === status.id)
      nodes.set(status.id, original)
    // The listed tweet of a repost is the repost itself, so its time is when
    // it was reposted. A promoted one is out of order.
    if (!listings.has(status.id))
      listings.set(status.id, {
        listedAt: promoted ? '' : isoTime(tweet.legacy?.created_at),
        pinned,
      })
    results.push(status)
  }
  const bottom = processTimelineInstructions(instructions).cursors.find(
    (c) => c.cursorType === 'Bottom',
  )?.value
  return {
    timeline: { code: 200, results, cursor: { bottom } },
    nodes,
    listings,
    pins,
  }
}

export async function fetchSessionTimeline(
  result: FetchResponse,
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  cursor = '',
  pageSize = 0,
  since = '',
): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const responses: SourceResponse[] = []
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, {
      target: 'profile',
      fetcher,
      responses,
    }),
    shouldTranscodeGif: () => false,
  }
  // The first page carries the pinned post as an instruction of its own,
  // whatever its size; without one nothing is pinned. Later pages cannot
  // tell, nor can a timeline that was not read.
  let pins: string[] | undefined
  try {
    await collectTimeline(
      result,
      async (next) => {
        const recorded = responses.length
        const page = await sessionTimelinePage(
          result.canonicalTarget!.externalId,
          Math.min(pageSize || 100, 100),
          next || null,
          host,
        )
        const { timeline, nodes, listings } = page
        if (!next) pins = page.pins
        const sourceUrl = responses.slice(recorded).at(-1)?.sourceUrl ?? ''
        return {
          timeline,
          prefetch: (post: any) =>
            sessionPrefetch(nodes.get(post.id), sourceUrl),
          listing: (post: any) => listings.get(post.id),
        }
      },
      cursor,
      pageSize,
      since,
    )
  } catch {
    result.incomplete = true
    result.warnings.push('帖子获取中断。')
  }
  if (pins) recordPinnedPosts(result, pins)
  result.sourceResponses.push(...responses)
}
