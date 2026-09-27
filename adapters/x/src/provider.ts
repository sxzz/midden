import { attachEntities } from "./entities.js";
import { status, Metadata } from "@grpc/grpc-js";
import {
  FetchResponse,
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
export function responseError(
  code: number,
  retry: string | null = null,
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
  return new ProviderError(
    status.FAILED_PRECONDITION,
    "provider cannot access this post",
  );
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
        immutableKey:
          kind === "video" && item.id ? `${item.id}:${parsed.pathname}` : "",
        altText: (item.altText ?? "").trim(),
        sensitive: Boolean(
          post.possibly_sensitive || item.sensitive || item.possibly_sensitive,
        ),
      });
    }
    if (unsupported || post.media.external) warn("此类媒体暂不支持归档。");
    if (invalid) warn("部分媒体缺少有效下载地址。");
  }
  if (post.article) warn("文章正文暂不支持归档。");
  if (!result.text && !result.resources.length)
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      "provider returned no supported text or media",
    );
  attachEntities(result, post, raw);
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
  if (!response.ok)
    throw responseError(response.status, response.headers.get("retry-after"));
  let rawBody = Buffer.alloc(0);
  const data = await readJSON(response, (body) => {
    rawBody = Buffer.from(body);
  });
  if (typeof data.code !== "number")
    throw new ProviderError(status.UNAVAILABLE, "invalid provider response");
  if (data.code !== 200)
    throw responseError(data.code, response.headers.get("retry-after"));
  if (data.status?.author?.protected)
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      "public provider cannot archive private posts",
    );
  const result = normalize(
    data.status,
    id,
    "fxtwitter",
    Visibility.VISIBILITY_PUBLIC,
  );
  result.sourceResponses = [
    {
      body: rawBody,
      contentType: response.headers.get("content-type") ?? "application/json",
      sourceUrl: `${endpoint}/${id}`,
      visibility: Visibility.VISIBILITY_PUBLIC,
    },
  ];
  return result;
}
