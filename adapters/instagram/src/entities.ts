import { status } from "@grpc/grpc-js";
import {
  captionFromMedia,
  instagramNodeToStatus,
} from "@fxembed/atmosphere/providers/instagram/processor";
import {
  Entity,
  FetchResponse,
  Resource,
  ResolveResponse,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";
import { type Node, mediaId } from "./client.js";
import { ProviderError } from "./errors.js";
import { handlePattern, shortcodeFromPk } from "./resolve.js";

export const version = "0.1.0";
const nonnegative = { type: "integer", minimum: 0 };
export const entityTypes = Object.entries({
  "instagram.post": {
    type: "object",
    required: ["text", "shortcode"],
    properties: {
      text: { type: "string" },
      shortcode: { type: "string" },
      likes: nonnegative,
      replies: nonnegative,
      published_at: { type: "string", format: "date-time" },
      edited_at: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  },
  "instagram.profile": {
    type: "object",
    required: ["username", "name", "metadata"],
    properties: {
      username: { type: "string" },
      name: { type: "string" },
      avatar_url: { type: "string" },
      metadata: { type: "object" },
    },
    additionalProperties: false,
  },
}).map(([name, schema]) => ({
  name,
  jsonSchema: Buffer.from(
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...schema,
    }),
  ),
}));

export function timestamp(raw: unknown): string {
  if (typeof raw !== "number" && typeof raw !== "string") return "";
  if (typeof raw === "number" && raw <= 0) return "";
  const date = new Date(typeof raw === "number" ? raw * 1000 : raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
function count(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : undefined;
}

export function attachProfile(
  result: FetchResponse,
  user: Node,
  key = "author",
  contextOnly = true,
): Entity | undefined {
  const id = String(user.pk ?? user.id ?? "");
  if (!/^\d+$/.test(id) || !handlePattern.test(user.username ?? "")) return;
  const metadata: Node = {};
  const fields: Node = {
    description: user.biography,
    protected: user.is_private,
    followers: user.follower_count ?? user.edge_followed_by?.count,
    following: user.following_count ?? user.edge_follow?.count,
    statuses: user.media_count ?? user.edge_owner_to_timeline_media?.count,
    url: user.external_url,
    verified: user.is_verified,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (
      ["followers", "following", "statuses"].includes(name)
        ? count(value) !== undefined
        : ["protected", "verified"].includes(name)
          ? typeof value === "boolean"
          : typeof value === "string"
    )
      metadata[name] = value;
  }
  const avatar =
    user.hd_profile_pic_url_info?.url ??
    user.profile_pic_url_hd ??
    user.profile_pic_url ??
    user.profile_image_uri;
  const data: Node = {
    username: user.username,
    name: typeof user.full_name === "string" ? user.full_name : user.username,
    metadata,
  };
  const entity = Entity.fromPartial({
    key,
    type: "instagram.profile",
    externalId: id,
    contextOnly,
    dataJson: Buffer.from(JSON.stringify(data)),
  });
  if (typeof avatar === "string" && avatar) {
    data.avatar_url = avatar;
    entity.dataJson = Buffer.from(JSON.stringify(data));
    entity.resourceIndices.push(result.resources.length);
    result.resources.push(
      Resource.fromPartial({
        url: avatar,
        kind: "image",
        purpose: "avatar",
        immutableKey: `instagram:avatar:${avatar}`,
      }),
    );
  }
  result.graph!.entities.push(entity);
  return entity;
}

export function profileResult(
  user: Node,
  requested: string,
  visibility: Visibility,
): FetchResponse {
  const result = FetchResponse.fromPartial({
    externalId: requested,
    adapterVersion: version,
    visibility,
    textKind: "profile",
    text: typeof user.biography === "string" ? user.biography : "",
    authorName: user.full_name || user.username,
    graph: { root: "author" },
  });
  const entity = attachProfile(result, user, "author", false);
  if (!entity)
    throw new ProviderError(status.UNAVAILABLE, "invalid Instagram profile");
  result.summary = `${result.authorName}：${result.text || `@${user.username}`}`;
  result.canonicalTarget = ResolveResponse.fromPartial({
    url: `https://www.instagram.com/${user.username}/`,
    platform: "instagram",
    kind: "profile",
    externalId: entity.externalId,
    refreshOnSubmit: true,
    collection: true,
  });
  return result;
}

function quality(node: Node): Node {
  const result = { ...node };
  const byQuality = (a: Node, b: Node) =>
    (Number(b.width) * Number(b.height) || 0) -
      (Number(a.width) * Number(a.height) || 0) ||
    (Number(b.bandwidth ?? b.bitrate ?? b.type) || 0) -
      (Number(a.bandwidth ?? a.bitrate ?? a.type) || 0);
  const image = node.image_versions2?.candidates;
  if (Array.isArray(image)) {
    const sorted = [...image]
      .filter((v) => typeof v.url === "string")
      .sort(byQuality);
    result.image_versions2 = { ...node.image_versions2, candidates: sorted };
    if (sorted[0]) {
      result.display_url = sorted[0].url;
      result.dimensions = { width: sorted[0].width, height: sorted[0].height };
    }
  }
  if (Array.isArray(node.display_resources)) {
    const best = [...node.display_resources].sort(
      (a, b) =>
        (b.config_width * b.config_height || 0) -
        (a.config_width * a.config_height || 0),
    )[0];
    if (best?.src) {
      result.display_url = best.src;
      result.dimensions = {
        width: best.config_width,
        height: best.config_height,
      };
    }
  }
  if (Array.isArray(node.video_versions)) {
    const best = [...node.video_versions]
      .filter((v) => typeof v.url === "string")
      .sort(byQuality)[0];
    if (best) {
      result.video_url = best.url;
      // Atmosphere also ranks variants. Pass only the chosen encode so its
      // type-based tie breaker cannot replace the higher bitrate rendition.
      result.video_versions = [best];
      result.dimensions = { width: best.width, height: best.height };
    }
  }
  return result;
}

function children(node: Node): Node[] {
  if (Array.isArray(node.carousel_media)) return node.carousel_media;
  if (Array.isArray(node.edge_sidecar_to_children?.edges))
    return node.edge_sidecar_to_children.edges.map((edge: Node) => edge.node);
  if (Array.isArray(node.children)) return node.children;
  return [node];
}

export function postResult(
  node: Node,
  requested: string,
  visibility: Visibility,
): FetchResponse {
  if (mediaId(node) !== requested)
    throw new ProviderError(
      status.UNAVAILABLE,
      "Instagram returned a different post",
    );
  const shortcode = shortcodeFromPk(requested);
  const user = node.user ?? node.owner ?? {};
  const text = captionFromMedia(node);
  const data: Node = { text, shortcode };
  const published = timestamp(node.taken_at ?? node.taken_at_timestamp);
  const edited = timestamp(node.caption?.edited_at ?? node.edited_at);
  if (published) data.published_at = published;
  if (edited) data.edited_at = edited;
  for (const [key, value] of [
    [
      "likes",
      node.like_count ??
        node.edge_liked_by?.count ??
        node.edge_media_preview_like?.count,
    ],
    ["replies", node.comment_count ?? node.edge_media_to_comment?.count],
  ] as const) {
    const n = count(value);
    if (n !== undefined) data[key] = n;
  }
  const result = FetchResponse.fromPartial({
    externalId: requested,
    adapterVersion: version,
    visibility,
    text,
    textKind: "post_text",
    publishedAt: published,
    authorName: user.full_name || user.username || "",
    graph: {
      root: "post",
      entities: [
        {
          key: "post",
          type: "instagram.post",
          externalId: requested,
          dataJson: Buffer.from(JSON.stringify(data)),
        },
      ],
    },
  });
  const slides = children(node);
  for (let index = 0; index < slides.length; index++) {
    const slide = slides[index];
    if (!slide || typeof slide !== "object") continue;
    // Normalize each slide separately so missing media cannot shift carousel identities.
    const selected = quality(slide);
    const normalized = instagramNodeToStatus(
      { ...selected, code: shortcode },
      { id: String(user.pk ?? user.id ?? ""), username: user.username ?? "" },
    );
    const media = normalized?.media?.all?.[0];
    if (!media?.url) continue;
    const id = mediaId(slide);
    result.graph!.entities[0]!.resourceIndices.push(result.resources.length);
    result.resources.push(
      Resource.fromPartial({
        url: media.url,
        kind: media.type === "video" ? "video" : "image",
        immutableKey: `instagram:media:${id || `${requested}:${index}`}:${media.type}:${media.width}x${media.height}:${selected.video_versions?.[0]?.bandwidth ?? selected.video_versions?.[0]?.bitrate ?? selected.video_versions?.[0]?.type ?? ""}`,
        altText:
          typeof slide.accessibility_caption === "string"
            ? slide.accessibility_caption
            : "",
        sensitive: slide.is_sensitive === true || node.is_sensitive === true,
      }),
    );
  }
  if (
    result.resources.length <
    Math.max(slides.length, Number(node.carousel_media_count) || 1)
  ) {
    result.incomplete = true;
    result.warnings.push("部分 Instagram 图片或视频未提供可下载地址。");
  }
  const author = attachProfile(result, user);
  if (author) {
    result.graph!.relations.push({
      source: "post",
      target: author.key,
      type: "authored_by",
    });
    result.relatedTargets.push({
      url: `https://www.instagram.com/${user.username}/`,
      refreshAfterSeconds: 60,
      updatedAt: "",
    });
  }
  result.summary = `${result.authorName || "Instagram"}：${text || "图片或视频"}`;
  return result;
}

export function attachMentions(result: FetchResponse, text: string): void {
  const targets = new Set(result.relatedTargets.map((target) => target.url));
  for (const match of text.matchAll(
    /(?<![\w@./])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)(?![\w.])/g,
  )) {
    const handle = match[1]!.toLowerCase();
    const url = `https://www.instagram.com/${handle}/`;
    if (targets.has(url) || handle.includes("..") || targets.size >= 20)
      continue;
    const key = `mention_${targets.size}`;
    result.graph!.entities.push(
      Entity.fromPartial({
        key,
        type: "instagram.profile",
        externalId: `handle:${handle}`,
        contextOnly: true,
        dataJson: Buffer.from(
          JSON.stringify({ username: handle, name: handle, metadata: {} }),
        ),
      }),
    );
    result.graph!.relations.push({
      source: result.graph!.root,
      target: key,
      type: "mentions",
    });
    result.relatedTargets.push({ url, refreshAfterSeconds: 60, updatedAt: "" });
    targets.add(url);
  }
}
