import { test } from "node:test";
import assert from "node:assert/strict";
import { preferOriginalAvatars } from "./avatar.js";
import { FetchResponse } from "./generated/api/adapter/v1/adapter.js";
const url = "https://pbs.twimg.com/profile_images/123/fixture_normal.jpg";
const result = () =>
  FetchResponse.fromPartial({
    resources: [
      { purpose: "avatar", url },
      { purpose: "avatar", url },
    ],
  });

test("original avatar uses accessible image URL and matching immutable key", async () => {
  const r = result();
  let calls = 0;
  await preferOriginalAvatars(r, AbortSignal.timeout(1000), async (input) => {
    calls++;
    assert.equal(input, url.replace("_normal", ""));
    return new Response("image", {
      status: 206,
      headers: { "content-type": "image/jpeg" },
    });
  });
  assert.equal(calls, 1);
  for (const resource of r.resources) {
    assert.equal(resource.url, url.replace("_normal", ""));
    assert.equal(resource.immutableKey, `x:avatar:${resource.url}`);
  }
});

test("unavailable or non-image original avatars retain their original URL", async () => {
  for (const fetcher of [
    async () => new Response("missing", { status: 404 }),
    async () =>
      new Response("html", { headers: { "content-type": "text/html" } }),
    async () => {
      throw new Error("timeout");
    },
  ]) {
    const r = result();
    await preferOriginalAvatars(
      r,
      AbortSignal.timeout(1000),
      fetcher,
      new Map(),
    );
    assert.equal(r.resources[0].url, url);
    assert.equal(r.resources[0].immutableKey, `x:avatar:${url}`);
  }
});

test("other media, avatar sizes and hosts are not probed", async () => {
  const r = FetchResponse.fromPartial({
    resources: [
      { purpose: "avatar", url: url.replace("_normal", "_400x400") },
      { purpose: "avatar", url: url.replace("pbs.twimg.com", "example.com") },
      { purpose: "", url },
    ],
  });
  let calls = 0;
  await preferOriginalAvatars(r, AbortSignal.timeout(1000), async () => {
    calls++;
    return new Response(null, { status: 404 });
  });
  assert.equal(calls, 0);
});

test("an original avatar found once is not probed again", async () => {
  const known = new Map<string, string>();
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    const r = result();
    await preferOriginalAvatars(
      r,
      AbortSignal.timeout(1000),
      async () => {
        calls++;
        return new Response("image", {
          status: 206,
          headers: { "content-type": "image/jpeg" },
        });
      },
      known,
    );
    assert.equal(r.resources[0].url, url.replace("_normal", ""));
  }
  assert.equal(calls, 1);
});
