import { status } from "@grpc/grpc-js";
import { profileStatusesAPI } from "@fxembed/atmosphere/providers/twitter/userStatuses";
import type { TwitterBuildHost } from "@fxembed/atmosphere/providers/twitter/build-host";
import type { SessionCredential } from "./credential.js";
import { accountTransport } from "./session.js";
import {
  attachEntities,
  attachMentions,
  attachProfileReference,
  addRelation,
} from "./entities.js";
import { ProviderError, readJSON, responseError } from "./provider.js";
import {
  FetchResponse,
  SourceResponse,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";

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

export function attachTimeline(result: FetchResponse, timeline: any): void {
  if (timeline?.code !== 200 || !Array.isArray(timeline.results))
    throw new ProviderError(
      status.UNAVAILABLE,
      "invalid profile timeline response",
    );
  const ids = new Set<string>();
  for (const post of timeline.results) {
    if (
      post?.type === "status" &&
      typeof post.id === "string" &&
      /^\d+$/.test(post.id)
    ) {
      ids.add(post.id);
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
  for (const id of ids) {
    const url = `https://x.com/i/web/status/${id}`;
    targets.set(url, { url, refreshAfterSeconds: 0 });
  }
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
  if (!response.ok)
    throw responseError(response.status, response.headers.get("retry-after"));
  const data = await readJSON(response, (body) =>
    responses.push({
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
      sourceUrl: url,
      visibility: Visibility.VISIBILITY_PUBLIC,
    }),
  );
  if (data?.code !== 200)
    throw responseError(typeof data?.code === "number" ? data.code : 502);
  return data;
}
// Keep whole upstream pages: the requested size is a target, never a truncation boundary.
export async function collectTimeline(
  result: FetchResponse,
  fetchPage: (cursor: string) => Promise<any>,
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
      result.warnings.push("连续翻页已达单次处理上限，可继续抓取剩余帖子。");
      break;
    }
    visited.add(cursor);
    const page = FetchResponse.fromPartial({ graph: result.graph });
    // Advance the checkpoint only after successfully parsing the entire page.
    attachTimeline(page, await fetchPage(cursor));
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
      (next) =>
        publicJSON(
          `https://api.fxtwitter.com/2/profile/id:${result.canonicalTarget!.externalId}/statuses?count=${Math.min(pageSize || 100, 100)}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
          signal,
          result.sourceResponses,
          fetcher,
        ),
      cursor,
      pageSize,
    );
  } catch {
    result.incomplete = true;
    result.warnings.push(
      "帖子获取中断；已获取的帖子会继续保存，可重试或继续抓取。",
    );
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
      result.warnings.push(
        "帖子获取中断；已获取的帖子会继续保存，可重试或继续抓取。",
      );
    }
  }
  result.sourceResponses = responses;
  return result;
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
      (next) =>
        profileStatusesAPI(
          { type: "userId", value: result.canonicalTarget!.externalId },
          Math.min(pageSize || 100, 100),
          next || null,
          host,
        ),
      cursor,
      pageSize,
    );
  } catch {
    result.incomplete = true;
    result.warnings.push(
      "帖子获取中断；已获取的帖子会继续保存，可重试或继续抓取。",
    );
  }
  result.sourceResponses.push(...responses);
}
