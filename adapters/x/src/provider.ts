import { attachEntities } from "./entities.js";
import { status, Metadata } from "@grpc/grpc-js";
import {
  FetchResponse,
  SourceResponse,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";

export class ProviderError extends Error {
  metadata = new Metadata();
  constructor(
    public code: status,
    message: string,
    retrySeconds = 0,
  ) {
    super(message);
    if (retrySeconds > 0)
      this.metadata.set("retry-after", String(Math.min(86400, retrySeconds)));
  }
}
/** Trailer telling the core to repeat a deferred fetch with the account. */
export const credentialRequiredKey = "credential-required";
/** Trailer telling the core the post itself is gone, not merely unreadable. */
export const sourceStateKey = "source-state";
export type SourceState = "deleted" | "suspended";
export function sourceState(error: unknown): SourceState | undefined {
  if (!(error instanceof ProviderError)) return;
  const [value] = error.metadata.get(sourceStateKey);
  return value === "deleted" || value === "suspended" ? value : undefined;
}
export function responseError(
  code: number,
  retry: string | null = null,
  target: "post" | "profile" = "post",
  reason?: unknown,
): ProviderError {
  if (code === 401)
    return new ProviderError(
      status.UNAUTHENTICATED,
      "account session expired; authorize again",
    );
  if (code === 403)
    return new ProviderError(
      status.PERMISSION_DENIED,
      "account cannot access this post",
    );
  if (code === 429 || code >= 500) {
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry)
        : retry
          ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
          : 0;
    return new ProviderError(
      status.UNAVAILABLE,
      "provider temporarily unavailable",
      seconds,
    );
  }
  // Not retried within this job, but nothing is blocked: a suspension can be
  // lifted, and a later refresh or profile capture asks upstream again.
  if (code === 404 && reason === "suspended") {
    const error = new ProviderError(
      status.FAILED_PRECONDITION,
      "account is suspended",
    );
    error.metadata.set(sourceStateKey, "suspended");
    return error;
  }
  if (code === 404)
    return new ProviderError(
      status.FAILED_PRECONDITION,
      target === "profile" ? "profile not found" : "post not found or deleted",
    );
  return new ProviderError(
    status.FAILED_PRECONDITION,
    `provider cannot access this ${target}`,
  );
}
// Only the public post API answers 404 for a post that no longer exists; it
// answers 401 for one that exists but is protected. A 404 from the GraphQL
// endpoints means a stale query, so they never mark a post as gone.
function publicPostError(
  code: number,
  retry: string | null,
  reason: unknown,
): ProviderError {
  const error = responseError(code, retry, "post", reason);
  if (code === 404 && reason !== "suspended")
    error.metadata.set(sourceStateKey, "deleted");
  return error;
}
// FxTwitter v2 nests a tombstone's reason under `status`.
const upstreamReason = (data: any) => data?.reason ?? data?.status?.reason;
/** Error for a failed HTTP response, keeping the reason from its JSON body. */
export async function upstreamError(
  response: Response,
  target: "post" | "profile",
): Promise<ProviderError> {
  let reason: unknown;
  try {
    const text = await response.text();
    if (text.length <= 64 << 10) reason = upstreamReason(JSON.parse(text));
  } catch {}
  const retry = response.headers.get("retry-after");
  return target === "post"
    ? publicPostError(response.status, retry, reason)
    : responseError(response.status, retry, target, reason);
}
export async function readJSON(
  response: Response,
  retain?: (body: Buffer) => void,
): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ProviderError(status.UNAVAILABLE, "empty provider response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 << 20) throw new Error("size");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    retain?.(body);
    return JSON.parse(body.toString("utf8"));
  } catch {
    await reader.cancel();
    throw new ProviderError(status.UNAVAILABLE, "invalid provider response");
  }
}
export function normalize(
  post: any,
  id: string,
  provider: string,
  visibility: Visibility,
  raw?: any,
): FetchResponse {
  if (post?.type === "tombstone")
    throw new ProviderError(
      status.PERMISSION_DENIED,
      "account cannot access this post",
    );
  if (
    post?.type !== "status" ||
    post.id !== id ||
    typeof post.text !== "string"
  )
    throw new ProviderError(status.UNAVAILABLE, "invalid provider post");
  const result = FetchResponse.fromPartial({
    externalId: id,
    providerId: provider,
    visibility,
    text: post.text.trim(),
    textKind: "post_text",

    textSource: provider,
    adapterVersion: "0.4.0",
  });
  const warn = (text: string) => {
    result.incomplete = true;
    result.warnings.push(text);
  };
  if (!post.media) warn("未能确认帖子媒体信息。");
  else {
    const seen = new Set<string>();
    let unsupported = false,
      invalid = false;
    for (const item of post.media.all ?? [
      ...(post.media.photos ?? []),
      ...(post.media.videos ?? []),
    ]) {
      if (!["photo", "video", "gif"].includes(item.type)) {
        unsupported = true;
        continue;
      }
      const kind = item.type === "photo" ? "image" : "video";
      let url = item.url;
      if (kind === "video") {
        const formats = (item.formats ?? [])
          .filter((f: any) => ["mp4", "webm"].includes(f.container) && f.url)
          .sort(
            (a: any, b: any) =>
              (b.width ?? 0) * (b.height ?? 0) -
                (a.width ?? 0) * (a.height ?? 0) ||
              (b.bitrate ?? 0) - (a.bitrate ?? 0),
          );
        if (formats.length) url = formats[0].url;
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new Error();
        if (kind === "video" && !/\.(mp4|webm)$/i.test(parsed.pathname))
          throw new Error();
      } catch {
        invalid = true;
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      result.resources.push({
        url,
        kind,
        purpose: "",
        immutableKey: item.id
          ? `x:media:${kind}:${item.id}`
          : `x:media:${kind}:url:${parsed.href}`,
        altText: (item.altText ?? "").trim(),
        sensitive: Boolean(
          post.possibly_sensitive || item.sensitive || item.possibly_sensitive,
        ),
      });
    }
    if (unsupported || post.media.external) warn("不支持此类媒体。");
    if (invalid) warn("部分媒体缺少有效下载地址。");
  }
  if (post.article) warn("不支持文章正文。");
  if (!result.text && !result.resources.length)
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      "provider returned no supported text or media",
    );
  const markers = result.resources
    .map((r) => (r.kind === "image" ? "[图片]" : "[视频]"))
    .join("");
  attachEntities(result, post, raw);
  result.summary = `${result.authorName || "未知作者"}：${result.text}${markers}`;
  return result;
}
export async function fetchPublic(
  id: string,
  signal: AbortSignal,
  endpoint = "https://api.fxtwitter.com/2/status",
): Promise<FetchResponse> {
  const response = await fetch(`${endpoint}/${id}`, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "Monitor/0.4" },
  });
  if (!response.ok) throw await upstreamError(response, "post");
  let rawBody = Buffer.alloc(0);
  const data = await readJSON(response, (body) => {
    rawBody = Buffer.from(body);
  });
  if (typeof data.code !== "number")
    throw new ProviderError(status.UNAVAILABLE, "invalid provider response");
  if (data.code !== 200)
    throw publicPostError(
      data.code,
      response.headers.get("retry-after"),
      upstreamReason(data),
    );
  return publicPost(data.status, id, {
    body: rawBody,
    contentType: response.headers.get("content-type") ?? "application/json",
    sourceUrl: `${endpoint}/${id}`,
    visibility: Visibility.VISIBILITY_PUBLIC,
  });
}

/** Normalizes a public API status, whichever public response carried it. */
export function publicPost(
  post: any,
  id: string,
  source: SourceResponse,
): FetchResponse {
  const containsProtectedAuthor = (
    post: any,
    seen = new Set<any>(),
  ): boolean => {
    if (!post || typeof post !== "object" || seen.has(post)) return false;
    seen.add(post);
    return (
      Boolean(post.author?.protected) ||
      containsProtectedAuthor(post.quote, seen) ||
      containsProtectedAuthor(post.repost, seen)
    );
  };
  if (containsProtectedAuthor(post))
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      "public provider cannot save private posts",
    );
  const result = normalize(post, id, "fxtwitter", Visibility.VISIBILITY_PUBLIC);
  result.sourceResponses = [source];
  return result;
}
