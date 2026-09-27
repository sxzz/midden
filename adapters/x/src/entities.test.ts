import { test } from "node:test";
import assert from "node:assert/strict";
import { attachEntities } from "./entities.js";
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
