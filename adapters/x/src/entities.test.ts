import { test } from "node:test";
import assert from "node:assert/strict";
import { attachEntities, avatarImmutableKey } from "./entities.js";
import { FetchResponse } from "./generated/api/adapter/v1/adapter.js";
import { fetchPublic } from "./provider.js";
import { createServer } from "node:http";

test("profile metadata excludes account view state and never invents edit times", () => {
  const p = {
    author: {
      id: "123",
      name: "n",
      screen_name: "u",
      avatar_url: "https://img.test/a",
      description: "bio",
      followers: 4,
      following: false,
      followed_by: true,
      blocking: true,
    },
    created_at: "Thu Jan 01 00:00:00 +0000 2026",
  };
  const build = (post: any, raw?: any) => {
    const r = FetchResponse.fromPartial({ externalId: "20", text: "hello" });
    attachEntities(r, post, raw);
    return r;
  };
  const result = build(p);
  const profile = result.graph!.entities.find((e) => e.key === "author")!;
  const data = JSON.parse(Buffer.from(profile.dataJson).toString());
  const root = (r: FetchResponse) =>
    JSON.parse(
      Buffer.from(
        r.graph!.entities.find((e) => e.key === "post")!.dataJson,
      ).toString(),
    );
  assert.equal(data.metadata.following, undefined);
  assert.equal(profile.externalId, "123");
  assert.equal(profile.contextOnly, true);
  assert.equal(root(result).published_at, "2026-01-01T00:00:00.000Z");
  assert.equal(root(result).edited_at, undefined);
  assert.ok(!JSON.stringify(data).includes("followed_by"));
  assert.equal(result.resources[profile.resourceIndices[0]].purpose, "avatar");
  assert.deepEqual(result.graph!.relations, [
    { source: "post", target: "author", type: "authored_by" },
  ]);
  const raw = {
    edit_control: {
      edit_tweet_ids: ["900000000000000001", "900000000000000002"],
      editable_until_msecs: "9999999999999",
    },
  };
  const edited = root(build(p, raw));
  assert.ok(edited.edited_at);
  assert.equal(edited.edited_at_source, "x_snowflake");
  assert.equal(
    root(build({}, { edit_control: { editable_until_msecs: "9999999999999" } }))
      .edited_at,
    undefined,
  );
});

test("public provider retains exact response bytes before parsing", async () => {
  const body =
    ' {"code":200,"unknown":{"value":42},"status":{"type":"status","id":"20","text":"hi","media":{"all":[]}}}\n';
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as any;
    const result = await fetchPublic(
      "20",
      AbortSignal.timeout(2000),
      `http://127.0.0.1:${address.port}`,
    );
    assert.equal(result.sourceResponses.length, 1);
    assert.equal(Buffer.from(result.sourceResponses[0].body).toString(), body);
  } finally {
    server.close();
  }
});

test("X avatar cache keys track the exact image URL and rendition", () => {
  const url = "https://pbs.twimg.com/profile_images/900001/avatar_400x400.jpg";
  const key = avatarImmutableKey(url);
  assert.ok(key);
  assert.equal(avatarImmutableKey(url), key);
  for (const changed of [
    url.replace("900001", "900002"),
    url.replace("400x400", "normal"),
    url + "?v=2",
  ]) {
    assert.notEqual(avatarImmutableKey(changed), key);
  }
  assert.equal(avatarImmutableKey("https://media.test/avatar.jpg"), "");
  assert.equal(
    avatarImmutableKey("https://pbs.twimg.com/profile_images/default.jpg"),
    "",
  );
  assert.equal(avatarImmutableKey("invalid"), "");
  const result = FetchResponse.fromPartial({ externalId: "900001" });
  attachEntities(result, { author: { id: "123", avatar_url: url } }, {});
  assert.equal(
    result.resources.find((r) => r.purpose === "avatar")?.immutableKey,
    key,
  );
});

test("post engagement is root content, with zero distinct from missing", () => {
  const r = FetchResponse.fromPartial({ externalId: "20", text: "post" });
  attachEntities(r, {
    replies: 12,
    reposts: 3,
    likes: 86,
    bookmarks: 9,
    quotes: 0,
    author: { id: "123", likes: 999, followers: 400 },
  });
  const post = r.graph!.entities.find((e) => e.key === "post")!;
  const data = JSON.parse(Buffer.from(post.dataJson).toString());
  assert.deepEqual(data, {
    text: "post",
    replies: 12,
    reposts: 3,
    likes: 86,
    bookmarks: 9,
    quotes: 0,
  });
  const invalid = FetchResponse.fromPartial({ externalId: "21", text: "post" });
  attachEntities(invalid, {
    replies: -1,
    reposts: 1.5,
    likes: "86",
    bookmarks: null,
    quotes: Infinity,
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(invalid.graph!.entities[0].dataJson).toString()),
    { text: "post" },
  );
});

test("post and author bio mentions keep graph identities and schedule profile capture", () => {
  const result = FetchResponse.fromPartial({
    externalId: "20",
    text: "Hi @Other and @other; email a@invalid.test",
  });
  attachEntities(result, {
    author: { id: "123", screen_name: "author", description: "with @Bio" },
    raw_text: { facets: [{ type: "mention", original: "Other", id: "456" }] },
    reposted_by: { id: "789", screen_name: "reposter", name: "Reposter" },
  });
  assert.deepEqual(
    result.graph!.entities.map((e) => e.externalId),
    ["20", "123", "456", "handle:bio", "789"],
  );
  assert.equal(
    result.graph!.relations.filter((r) => r.type === "mentions").length,
    2,
  );
  const repost = result.graph!.relations.find((r) => r.type === "reposted")!;
  assert.equal(
    result.graph!.entities.find((e) => e.key === repost.source)?.externalId,
    "789",
  );
  assert.equal(repost.target, "post");
  assert.deepEqual(
    result.relatedTargets.map((t) => t.url),
    [
      "https://x.com/i/user/123",
      "https://x.com/i/user/456",
      "https://x.com/bio",
      "https://x.com/i/user/789",
    ],
  );
});

test("quote and repost references preserve source identity and schedule complete captures", () => {
  const result = FetchResponse.fromPartial({ externalId: "20", text: "root" });
  const original = {
    type: "status",
    id: "21",
    text: "original @Friend",
    created_at: "2026-01-01T00:00:00Z",
    author: { id: "456", screen_name: "original_author", name: "Original" },
    raw_text: { facets: [{ type: "mention", original: "Friend", id: "789" }] },
    media: { all: [{ type: "photo", url: "https://media.test/original.jpg" }] },
  };
  attachEntities(result, {
    author: { id: "123", screen_name: "root_author" },
    quote: original,
    repost: original,
  });
  const graph = result.graph!;
  assert.equal(
    graph.entities.find((e) => e.key === graph.root)?.externalId,
    "20",
  );
  const reference = graph.entities.find(
    (e) => e.type === "x.post" && e.externalId === "21",
  )!;
  assert.equal(graph.entities.filter((e) => e.externalId === "21").length, 1);
  assert.equal(reference.contextOnly, true);
  assert.deepEqual(reference.resourceIndices, []);
  assert.deepEqual(JSON.parse(Buffer.from(reference.dataJson).toString()), {
    text: "original @Friend",
    published_at: "2026-01-01T00:00:00.000Z",
  });
  for (const type of ["quoted", "reposted"])
    assert.ok(
      graph.relations.some(
        (r) =>
          r.source === "post" && r.target === reference.key && r.type === type,
      ),
    );
  const authorKey = graph.entities.find((e) => e.externalId === "456")!.key;
  assert.ok(
    graph.relations.some(
      (r) =>
        r.source === reference.key &&
        r.target === authorKey &&
        r.type === "authored_by",
    ),
  );
  assert.equal(
    result.relatedTargets.filter(
      (t) => t.url === "https://x.com/i/web/status/21",
    ).length,
    1,
  );
  assert.ok(
    result.relatedTargets.some((t) => t.url === "https://x.com/i/user/456"),
  );
  assert.ok(
    result.relatedTargets.some((t) => t.url === "https://x.com/i/user/789"),
  );
  assert.equal(result.resources.length, 0);
});

test("unavailable quotes retain known IDs without inventing content; invalid and cyclic IDs are ignored", () => {
  const result = FetchResponse.fromPartial({ externalId: "20", text: "root" });
  const post: any = {
    id: "20",
    quote: { type: "tombstone", id: "21" },
    repost: { id: "not-a-post" },
  };
  post.quote.quote = post;
  attachEntities(result, post);
  assert.deepEqual(
    result.graph!.entities.map((e) => e.externalId),
    ["20", "21"],
  );
  assert.deepEqual(result.graph!.relations, [
    { source: "post", target: "post_1", type: "quoted" },
  ]);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.graph!.entities[1].dataJson).toString()),
    { text: "" },
  );
  assert.deepEqual(result.relatedTargets, [
    {
      url: "https://x.com/i/web/status/21",
      refreshAfterSeconds: 60,
      updatedAt: "",
    },
  ]);
});
