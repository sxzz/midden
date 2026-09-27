import {
  FetchResponse,
  EntityGraph,
  Resource,
} from "./generated/api/adapter/v1/adapter.js";

function timestamp(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

// Normalized public profile fields only; account-view relationships remain in private raw responses.
export function attachEntities(
  result: FetchResponse,
  post: any,
  raw?: any,
): void {
  const author = post.author;
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "description",
    "location",
    "url",
    "banner_url",
    "joined",
    "protected",
    "followers",
    "following",
    "statuses",
    "media_count",
    "likes",
  ]) {
    const value = author?.[key];
    const isCount = [
      "followers",
      "following",
      "statuses",
      "media_count",
      "likes",
    ].includes(key);
    if (
      isCount
        ? typeof value === "number" && Number.isFinite(value)
        : key === "protected"
          ? typeof value === "boolean"
          : typeof value === "string"
    )
      metadata[key] = value;
  }
  if (author?.website)
    metadata.website = {
      url: author.website.url,
      display_url: author.website.display_url,
    };
  if (author?.verification)
    metadata.verification = {
      verified: author.verification.verified,
      verified_at: author.verification.verified_at,
      type: author.verification.type,
    };
  const node = raw?.tweet ?? raw;
  const ids = node?.edit_control?.edit_tweet_ids ?? post.edit_ids ?? [];
  const editIds: string[] = Array.isArray(ids)
    ? ids.filter((id: unknown) => typeof id === "string" && /^\d+$/.test(id))
    : [];
  let editedAt = timestamp(post.edited_at ?? node?.legacy?.edited_at);
  let editedAtSource = editedAt ? "upstream" : "";
  // An edit creates a new Snowflake ID. Keep the derivation explicit, never use editable_until.
  if (!editedAt && new Set(editIds).size > 1) {
    const newest = editIds.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    const millis = Number((BigInt(newest) >> 22n) + 1288834974657n);
    if (Number.isSafeInteger(millis) && millis < 8640000000000000) {
      editedAt = new Date(millis).toISOString();
      editedAtSource = "x_snowflake";
    }
  }
  const data: Record<string, unknown> = { text: result.text };
  const published =
    timestamp(post.created_at) || timestamp(post.created_timestamp);
  if (published) data.published_at = published;
  if (editedAt) {
    data.edited_at = editedAt;
    data.edited_at_source = editedAtSource;
  }
  if (editIds.length) data.edit_ids = editIds;
  const graph = EntityGraph.fromPartial({
    root: "post",
    entities: [
      {
        key: "post",
        type: "x.post",
        externalId: result.externalId,
        dataJson: Buffer.from(JSON.stringify(data)),
        resourceIndices: result.resources.map((_, i) => i),
      },
    ],
  });
  if (typeof author?.id === "string" && author.id) {
    const resources: number[] = [];
    if (author.avatar_url) {
      resources.push(result.resources.length);
      result.resources.push(
        Resource.fromPartial({
          url: author.avatar_url,
          kind: "image",
          purpose: "avatar",
        }),
      );
    }
    graph.entities.push({
      key: "author",
      type: "x.profile",
      externalId: author.id,
      dataJson: Buffer.from(
        JSON.stringify({
          username: author.screen_name ?? "",
          name: author.name ?? "",
          avatar_url: author.avatar_url ?? "",
          metadata,
        }),
      ),
      resourceIndices: resources,
    });
    graph.relations.push({
      source: "post",
      target: "author",
      type: "authored_by",
    });
  }
  result.graph = graph;
}
