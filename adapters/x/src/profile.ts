import { status } from "@grpc/grpc-js";
import { graphQLOrchestrator } from "@fxembed/atmosphere/providers/twitter/graphql/orchestrator";
import { UserTweetsQuery } from "@fxembed/atmosphere/providers/twitter/graphql/queries";
import {
  getProfileStatusesTimelineInstructions,
  validateUserTweetsTimeline,
} from "@fxembed/atmosphere/providers/twitter/graphql/validators";
import { buildAPITwitterStatus } from "@fxembed/atmosphere/providers/twitter/processor";
import { processTimelineInstructions } from "@fxembed/atmosphere/providers/twitter/search";
import { isTombstone } from "@fxembed/atmosphere/helpers/tombstone";
import type { TwitterBuildHost } from "@fxembed/atmosphere/providers/twitter/build-host";
import type { SessionCredential } from "./credential.js";
import { accountTransport } from "./session.js";
import {
  attachEntities,
  attachMentions,
  attachProfileReference,
  addRelation,
  postUpdatedAt,
} from "./entities.js";
import {
  ProviderError,
  readJSON,
  responseError,
  upstreamError,
  profileRef,
} from "./provider.js";
import {
  FetchResponse,
  RelatedTarget,
  SourceResponse,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";

/**
 * What a timeline showed of one listed post. The core hands it back to the
 * capture of that post, which then needs no request of its own.
 */
export type Prefetch =
  | { source: "fxtwitter"; observed_at: string; source_url: string; post: any }
  | { source: "x-session"; observed_at: string; source_url: string; node: any };
export function encodePrefetch(value: Prefetch): Buffer | undefined {
  const body = Buffer.from(JSON.stringify(value));
  return body.length <= 64 << 10 ? body : undefined;
}
export function decodePrefetch(body: Uint8Array): Prefetch | undefined {
  if (!body.length) return;
  try {
    const value = JSON.parse(Buffer.from(body).toString());
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return;
  }
}
// The listing carries only a stub of an article and says who reposted a post
// into the timeline, which the post's own response never does.
function publicPrefetch(post: any, sourceUrl: string): Buffer | undefined {
  if (post.article) return;
  return encodePrefetch({
    source: "fxtwitter",
    observed_at: new Date().toISOString(),
    source_url: sourceUrl,
    post: { ...post, reposted_by: null },
  });
}

export function normalizeProfile(
  user: any,
  requested: string,
  provider: string,
): FetchResponse {
  if (
    user?.type !== "profile" ||
    typeof user.id !== "string" ||
    !/^\d+$/.test(user.id) ||
    typeof user.screen_name !== "string" ||
    typeof user.name !== "string" ||
    (!requested.startsWith("handle:") && requested !== user.id)
  )
    throw new ProviderError(status.UNAVAILABLE, "invalid profile response");
  const result = FetchResponse.fromPartial({
    externalId: requested,
    providerId: provider,
    adapterVersion: "0.4.0",
    textKind: "profile",
    textSource: provider,
    visibility:
      provider === "fxtwitter" || user.protected === false
        ? Visibility.VISIBILITY_PUBLIC
        : Visibility.VISIBILITY_PRIVATE,
    text: [`@${user.screen_name}`, user.description || ""]
      .filter(Boolean)
      .join("\n"),
    summary: `${user.name || user.screen_name}：${user.description || `@${user.screen_name}`}`,
    canonicalTarget: {
      url: `https://x.com/i/user/${user.id}`,
      externalId: user.id,
      platform: "x",
      kind: "profile",
      refreshOnSubmit: true,
      collection: true,
    },
    publicSubjects: user.protected === false ? [profileRef(user.id)] : [],
  });
  // Reuse the public field projection; account-view fields remain exclusively in private raw responses.
  attachEntities(result, { author: user });
  result.graph!.root = "author";
  result.graph!.entities = result.graph!.entities.filter(
    (e) => e.key === "author",
  );
  result.graph!.relations = [];
  result.relatedTargets = [];
  const entity = result.graph!.entities[0];
  entity.contextOnly = false;
  const data = JSON.parse(Buffer.from(entity.dataJson).toString());
  if (provider === "fxtwitter") data.metadata = user;
  for (const key of ["raw_description", "birthday", "about_account"]) {
    // Public API fields are retained completely; the original account response is private.
    if (provider === "fxtwitter" && user[key] !== undefined)
      data.metadata[key] = user[key];
  }
  entity.dataJson = Buffer.from(JSON.stringify(data));
  if (typeof user.banner_url === "string" && user.banner_url) {
    entity.resourceIndices.push(result.resources.length);
    result.resources.push({
      url: user.banner_url,
      kind: "image",
      purpose: "banner",
      immutableKey: `x:banner:${user.banner_url}`,
      altText: "",
      sensitive: false,
    });
  }
  attachMentions(
    result,
    "author",
    user.description,
    user.raw_description?.facets,
  );
  return result;
}

export function attachTimeline(
  result: FetchResponse,
  timeline: any,
  prefetch?: (post: any) => Buffer | undefined,
): void {
  if (timeline?.code !== 200 || !Array.isArray(timeline.results))
    throw new ProviderError(
      status.UNAVAILABLE,
      "invalid profile timeline response",
    );
  const ids = new Map<string, RelatedTarget>();
  for (const post of timeline.results) {
    if (
      post?.type === "status" &&
      typeof post.id === "string" &&
      /^\d+$/.test(post.id)
    ) {
      ids.set(
        post.id,
        RelatedTarget.fromPartial({
          url: `https://x.com/i/web/status/${post.id}`,
          updatedAt: postUpdatedAt(post),
          prefetch: prefetch?.(post),
        }),
      );
      if (result.graph && post.reposted_by?.id) {
        const profile = attachProfileReference(result, post.reposted_by);
        let entity = result.graph.entities.find(
          (item) => item.type === "x.post" && item.externalId === post.id,
        );
        if (!entity) {
          entity = {
            key: `timeline_${post.id}`,
            type: "x.post",
            externalId: post.id,
            contextOnly: true,
            dataJson: Buffer.from(
              JSON.stringify({
                text: typeof post.text === "string" ? post.text : "",
              }),
            ),
            resourceIndices: [],
          };
          result.graph.entities.push(entity);
        }
        if (profile) addRelation(result, profile, entity.key, "reposted");
      }
    }
  }
  if (ids.size > 200)
    throw new ProviderError(
      status.RESOURCE_EXHAUSTED,
      "profile timeline exceeds capture page limit",
    );
  result.nextPageCursor =
    ids.size && typeof timeline.cursor?.bottom === "string"
      ? timeline.cursor.bottom
      : "";
  const targets = new Map(
    result.relatedTargets.map((target) => [target.url, target]),
  );
  for (const target of ids.values()) targets.set(target.url, target);
  result.relatedTargets = [...targets.values()];
}

async function publicJSON(
  url: string,
  signal: AbortSignal,
  responses: SourceResponse[],
  fetcher: typeof fetch = fetch,
): Promise<any> {
  const response = await fetcher(url, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "Monitor/0.4" },
  });
  if (!response.ok) throw await upstreamError(response, "profile");
  const data = await readJSON(response, (body) =>
    responses.push({
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
      sourceUrl: url,
      visibility: Visibility.VISIBILITY_PUBLIC,
    }),
  );
  if (data?.code !== 200)
    throw responseError(
      typeof data?.code === "number" ? data.code : 502,
      null,
      "profile",
      data?.reason,
    );
  return data;
}
// Keep whole upstream pages: the requested size is a target, never a truncation boundary.
export async function collectTimeline(
  result: FetchResponse,
  fetchPage: (cursor: string) => Promise<{
    timeline: any;
    prefetch?: (post: any) => Buffer | undefined;
  }>,
  cursor = "",
  pageSize = 0,
): Promise<void> {
  const target = Math.min(pageSize || 100, 100);
  const targets = new Map(result.relatedTargets.map((t) => [t.url, t]));
  const visited = new Set<string>();
  result.nextPageCursor = cursor;
  let posts = 0;
  while (posts < target) {
    if (visited.has(cursor)) {
      result.nextPageCursor = "";
      break;
    }
    if (visited.size >= 20) {
      result.incomplete = true;
      result.warnings.push("已达单次翻页上限。");
      break;
    }
    visited.add(cursor);
    const page = FetchResponse.fromPartial({ graph: result.graph });
    // Advance the checkpoint only after successfully parsing the entire page.
    const { timeline, prefetch } = await fetchPage(cursor);
    attachTimeline(page, timeline, prefetch);
    for (const item of page.relatedTargets) targets.set(item.url, item);
    result.graph = page.graph;
    result.relatedTargets = [...targets.values()];
    posts = result.relatedTargets.filter((item) =>
      item.url.includes("/status/"),
    ).length;
    const next = page.nextPageCursor;
    result.nextPageCursor = visited.has(next) ? "" : next;
    if (!result.nextPageCursor) break;
    cursor = result.nextPageCursor;
  }
}

export async function fetchPublicTimeline(
  result: FetchResponse,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  cursor = "",
  pageSize = 0,
): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    await collectTimeline(
      result,
      async (next) => {
        const url = `https://api.fxtwitter.com/2/profile/id:${result.canonicalTarget!.externalId}/statuses?count=${Math.min(pageSize || 100, 100)}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`;
        const timeline = await publicJSON(
          url,
          signal,
          result.sourceResponses,
          fetcher,
        );
        return {
          timeline,
          prefetch: (post: any) => publicPrefetch(post, url),
        };
      },
      cursor,
      pageSize,
    );
  } catch {
    result.incomplete = true;
    result.warnings.push("帖子获取中断。");
  }
}

export async function fetchPublicProfile(
  id: string,
  expand: boolean,
  signal: AbortSignal,
  endpoint = "https://api.fxtwitter.com/2/profile",
  fetcher: typeof fetch = fetch,
): Promise<FetchResponse> {
  const responses: SourceResponse[] = [];
  const get = (url: string) => publicJSON(url, signal, responses, fetcher);
  const handle = id.startsWith("handle:") ? id.slice(7) : `id:${id}`;
  const data = await get(
    `${endpoint}/${encodeURIComponent(handle)}?about_account=1`,
  );
  const result = normalizeProfile(data.user, id, "fxtwitter");
  if (expand) {
    try {
      attachTimeline(
        result,
        await get(`${endpoint}/id:${data.user.id}/statuses?count=100`),
      );
    } catch {
      result.incomplete = true;
      result.warnings.push("帖子获取中断。");
    }
  }
  result.sourceResponses = responses;
  return result;
}

// The raw node of a post, which an account's single-post response would carry
// too; a repost lists the reposted post's node. A public author's post is read
// from the public API like any public post, so it gets no prefetch here.
function sessionPrefetch(node: any, sourceUrl: string): Buffer | undefined {
  const author = (node?.tweet ?? node)?.core?.user_results?.result;
  if ((author?.privacy?.protected ?? author?.legacy?.protected) !== true)
    return;
  return encodePrefetch({
    source: "x-session",
    observed_at: new Date().toISOString(),
    source_url: sourceUrl,
    node,
  });
}
function timelineNodes(instructions: any[]): any[] {
  const nodes: any[] = [];
  const visit = (content: any) => {
    const item = content?.itemContent ?? content?.content ?? content;
    if (item?.__typename === "TimelineTweet" && item.tweet_results?.result)
      nodes.push(item.tweet_results.result);
  };
  for (const instruction of instructions)
    for (const entry of instruction?.entries ??
      (instruction?.entry ? [instruction.entry] : [])) {
      visit(entry?.content);
      for (const item of entry?.content?.items ?? []) visit(item?.item);
    }
  return nodes;
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
      key: "tweets",
      required: true,
      methods: [
        {
          name: "UserTweets",
          query: UserTweetsQuery,
          weight: 1,
          validator: validateUserTweetsTimeline,
        },
      ],
      variables: { userId, count, cursor },
    },
  ]);
  if (!response.tweets?.success)
    throw new ProviderError(
      status.UNAVAILABLE,
      "invalid profile timeline response",
    );
  const instructions =
    getProfileStatusesTimelineInstructions(response.tweets.data) ?? [];
  const results: any[] = [];
  const nodes = new Map<string, any>();
  for (const node of timelineNodes(instructions)) {
    const tweet = node.tweet ?? node;
    const status: any = await buildAPITwitterStatus(
      host,
      tweet,
      undefined,
      null,
      false,
      false,
    ).catch(() => null);
    if (!status || isTombstone(status) || status.status) continue;
    const original = tweet.legacy?.retweeted_status_result?.result ?? node;
    if ((original.tweet ?? original).rest_id === status.id)
      nodes.set(status.id, original);
    results.push(status);
  }
  const bottom = processTimelineInstructions(instructions).cursors.find(
    (c) => c.cursorType === "Bottom",
  )?.value;
  return { timeline: { code: 200, results, cursor: { bottom } }, nodes };
}

export async function fetchSessionTimeline(
  result: FetchResponse,
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  cursor = "",
  pageSize = 0,
): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const responses: SourceResponse[] = [];
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, fetcher, responses),
    shouldTranscodeGif: () => false,
  };
  try {
    await collectTimeline(
      result,
      async (next) => {
        const recorded = responses.length;
        const { timeline, nodes } = await sessionTimelinePage(
          result.canonicalTarget!.externalId,
          Math.min(pageSize || 100, 100),
          next || null,
          host,
        );
        const sourceUrl = responses.slice(recorded).at(-1)?.sourceUrl ?? "";
        return {
          timeline,
          prefetch: (post: any) =>
            sessionPrefetch(nodes.get(post.id), sourceUrl),
        };
      },
      cursor,
      pageSize,
    );
  } catch {
    result.incomplete = true;
    result.warnings.push("帖子获取中断。");
  }
  result.sourceResponses.push(...responses);
}
