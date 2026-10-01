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

// X profile image paths identify a particular image and size, not the account.
// Keep the exact URL (including query parameters); do not cache arbitrary hosts.
export function avatarImmutableKey(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "pbs.twimg.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/profile_images\/\d+\/[^/]+$/.test(url.pathname)
    ) {
      return `x:avatar:${url.href}`;
    }
  } catch {}
  return "";
}

// Normalized public profile fields only; account-view relationships remain in private raw responses.
export function attachEntities(
  result: FetchResponse,
  post: any,
  raw?: any,
): void {
  const author = post.author;
  result.authorName = author?.name?.trim() || author?.screen_name?.trim() || "";
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
  for (const key of ["replies", "reposts", "likes", "bookmarks", "quotes"]) {
    const value = post[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      data[key] = value;
  }
  const published =
    timestamp(post.created_at) || timestamp(post.created_timestamp);
  result.publishedAt = published;
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
          immutableKey: avatarImmutableKey(author.avatar_url),
        }),
      );
    }
    result.relatedTargets = [
      { url: `https://x.com/i/user/${author.id}`, refreshAfterSeconds: 60 },
    ];
    graph.entities.push({
      key: "author",
      contextOnly: true,
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
  attachMentions(result, "post", result.text, post.raw_text?.facets);
  if (graph.entities.some((entity) => entity.key === "author"))
    attachMentions(
      result,
      "author",
      author.description,
      author.raw_description?.facets,
    );
  if (post.reposted_by?.id) {
    const key = attachProfileReference(result, post.reposted_by);
    if (key) addRelation(result, key, "post", "reposted");
  }
  attachPostReferences(result, "post", post);
}

// Embedded posts are context, not complete captures: their media and full
// history (including further quote/repost links) are fetched independently
// through relatedTargets. Only direct references belong to this capture.
function attachPostReferences(
  result: FetchResponse,
  source: string,
  post: any,
): void {
  for (const [field, relation] of [
    ["quote", "quoted"],
    ["repost", "reposted"],
  ]) {
    const referenced = post?.[field];
    const id = referenced?.id;
    if (typeof id !== "string" || !/^\d+$/.test(id) || id === result.externalId)
      continue;
    let entity = result.graph!.entities.find(
      (item) => item.type === "x.post" && item.externalId === id,
    );
    if (!entity) {
      const data: Record<string, unknown> = {
        text: typeof referenced.text === "string" ? referenced.text.trim() : "",
      };
      const published =
        timestamp(referenced.created_at) ||
        timestamp(referenced.created_timestamp);
      if (published) data.published_at = published;
      entity = {
        key: `post_${result.graph!.entities.length}`,
        type: "x.post",
        externalId: id,
        contextOnly: true,
        dataJson: Buffer.from(JSON.stringify(data)),
        resourceIndices: [],
      };
      result.graph!.entities.push(entity);
    }
    addRelation(result, source, entity.key, relation);
    const url = `https://x.com/i/web/status/${id}`;
    if (!result.relatedTargets.some((target) => target.url === url))
      result.relatedTargets.push({ url, refreshAfterSeconds: 60 });
    const author = attachProfileReference(result, referenced.author);
    if (author) addRelation(result, entity.key, author, "authored_by");
    attachMentions(
      result,
      entity.key,
      referenced.text,
      referenced.raw_text?.facets,
    );
    const reposter = attachProfileReference(result, referenced.reposted_by);
    if (reposter) addRelation(result, reposter, entity.key, "reposted");
  }
}

// References use stable IDs whenever the upstream supplies them. Handle-only
// mentions are still captured so canonical profile resolution can hydrate them.
export function attachProfileReference(
  result: FetchResponse,
  user: any,
): string | undefined {
  const username =
    typeof user?.screen_name === "string"
      ? user.screen_name.replace(/^@/, "")
      : "";
  const id =
    typeof user?.id === "string" && /^\d+$/.test(user.id)
      ? user.id
      : /^[A-Za-z0-9_]{1,15}$/.test(username)
        ? `handle:${username.toLowerCase()}`
        : "";
  if (!id || !result.graph) return;
  let entity = result.graph.entities.find(
    (item) =>
      item.type === "x.profile" &&
      (item.externalId === id ||
        (username &&
          JSON.parse(
            Buffer.from(item.dataJson).toString(),
          ).username?.toLowerCase() === username.toLowerCase())),
  );
  if (!entity) {
    entity = {
      key: `profile_${result.graph.entities.length}`,
      type: "x.profile",
      externalId: id,
      contextOnly: true,
      dataJson: Buffer.from(
        JSON.stringify({
          username,
          name: user.name || username,
          avatar_url: user.avatar_url || "",
          metadata: {},
        }),
      ),
      resourceIndices: [],
    };
    result.graph.entities.push(entity);
  }
  if (entity.key === result.graph.root) return entity.key;
  const url = /^\d+$/.test(entity.externalId)
    ? `https://x.com/i/user/${entity.externalId}`
    : `https://x.com/${username.toLowerCase()}`;
  if (!result.relatedTargets.some((target) => target.url === url))
    result.relatedTargets.push({ url, refreshAfterSeconds: 3600 });
  return entity.key;
}

export function addRelation(
  result: FetchResponse,
  source: string,
  target: string,
  type: string,
): void {
  if (
    !result.graph!.relations.some(
      (r) => r.source === source && r.target === target && r.type === type,
    )
  )
    result.graph!.relations.push({ source, target, type });
}

export function attachMentions(
  result: FetchResponse,
  source: string,
  text: unknown,
  facets: any,
): void {
  const mentions = new Map<string, any>();
  if (Array.isArray(facets))
    for (const facet of facets) {
      if (facet?.type === "mention" && typeof facet.original === "string") {
        const username = facet.original.replace(/^@/, "");
        if (/^[A-Za-z0-9_]{1,15}$/.test(username))
          mentions.set(username.toLowerCase(), {
            id: facet.id,
            screen_name: username,
          });
      }
    }
  if (typeof text === "string")
    for (const match of text.matchAll(
      /(?<![\w@./])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g,
    )) {
      const username = match[1];
      if (!mentions.has(username.toLowerCase()))
        mentions.set(username.toLowerCase(), { screen_name: username });
    }
  for (const user of mentions.values()) {
    const key = attachProfileReference(result, user);
    if (key) addRelation(result, source, key, "mentions");
  }
}
