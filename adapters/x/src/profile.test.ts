import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "./resolve.js";
import {
  fetchPublicProfile,
  normalizeProfile,
  attachTimeline,
} from "./profile.js";
import { Visibility } from "./generated/api/adapter/v1/adapter.js";
const user = {
  type: "profile",
  id: "12345678901234567890",
  name: "Fixture",
  screen_name: "fixture",
  protected: false,
  description: "Bio",
  followers: 42,
  about_account: { username_changes: { count: 2 } },
  new_upstream_field: { anything: true },
};

test("profile URLs resolve separately, refreshing on explicit submission", () => {
  assert.equal(
    resolveTarget("https://twitter.com/FiXtUrE?lang=en").externalId,
    "handle:fixture",
  );
  assert.equal(resolveTarget("https://x.com/i/user/123").externalId, "123");
  assert.equal(resolveTarget("https://x.com/fixture").refreshOnSubmit, true);
  for (const path of [
    "/home",
    "/i",
    "/settings",
    "/fixture/followers",
    "/fixture/status/no",
  ])
    assert.throws(() => resolveTarget(`https://x.com${path}`));
});

test("profile captures exact API responses and the entire first page, never follows cursor", async () => {
  const urls: string[] = [];
  const profileBody = JSON.stringify({ code: 200, user });
  const timelineBody = JSON.stringify({
    code: 200,
    results: Array.from({ length: 27 }, (_, i) => ({
      type: "status",
      id: String(i + 1),
    })),
    cursor: { bottom: "next-page" },
  });
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(urls.length === 1 ? profileBody : timelineBody, {
      headers: { "content-type": "application/json" },
    });
  };
  const r = await fetchPublicProfile(
    "handle:fixture",
    true,
    new AbortController().signal,
    "https://provider.test/profile",
    fetcher,
  );
  assert.equal(urls.length, 2);
  assert.equal(r.relatedTargets.length, 27);
  assert.equal(r.canonicalTarget?.externalId, user.id);
  assert.equal(r.graph!.entities[0].contextOnly, false);
  assert.equal(r.graph?.root, "author");
  assert.equal(r.graph?.entities.length, 1);
  assert.equal(Buffer.from(r.sourceResponses[0].body).toString(), profileBody);
  assert.equal(Buffer.from(r.sourceResponses[1].body).toString(), timelineBody);
  assert.equal(new URL(urls[1]).searchParams.get("count"), "100");
  assert.ok(!urls.some((url) => new URL(url).searchParams.has("cursor")));
});

test("automatic profile captures skip timeline; timeline failure keeps full profile", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: 200, user }));
  };
  const r = await fetchPublicProfile(
    user.id,
    false,
    new AbortController().signal,
    "https://provider.test/profile",
    fetcher,
  );
  assert.equal(calls, 1);
  assert.equal(r.relatedTargets.length, 0);
  let attempt = 0;
  const partial = await fetchPublicProfile(
    user.id,
    true,
    new AbortController().signal,
    "https://provider.test/profile",
    async () =>
      ++attempt === 1
        ? new Response(JSON.stringify({ code: 200, user }))
        : new Response("{}", { status: 503 }),
  );
  assert.equal(partial.incomplete, true);
  assert.equal(partial.graph?.entities[0].externalId, user.id);
});

test("profile visibility is conservative and account view fields stay out of public entity", () => {
  assert.equal(
    normalizeProfile({ ...user, protected: true }, user.id, "fxtwitter")
      .visibility,
    Visibility.VISIBILITY_PUBLIC,
  );
  const r = normalizeProfile(
    { ...user, blocked_by: true, following: true },
    user.id,
    "x-session",
  );
  assert.equal(r.visibility, Visibility.VISIBILITY_PUBLIC);
  assert.ok(
    !Buffer.from(r.graph!.entities[0].dataJson)
      .toString()
      .includes("blocked_by"),
  );
  assert.equal(
    normalizeProfile({ ...user, protected: undefined }, user.id, "x-session")
      .visibility,
    Visibility.VISIBILITY_PRIVATE,
  );
  assert.throws(() => normalizeProfile(user, "123", "x-session"));
  attachTimeline(r, {
    code: 200,
    results: [
      { type: "status", id: "42" },
      { type: "status", id: "42" },
      { type: "profile", id: "77" },
    ],
  });
  assert.equal(r.relatedTargets.length, 1);
});

test("public pagination sends opaque cursor and count 100 without credentials", async () => {
  const { fetchPublicTimeline } = await import("./profile.js");
  const result = normalizeProfile(user, user.id, "fxtwitter");
  await fetchPublicTimeline(
    result,
    AbortSignal.timeout(1000),
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("cursor"), "next/+ =");
      assert.equal(url.searchParams.get("count"), "100");
      assert.equal(new Headers(init?.headers).has("cookie"), false);
      return new Response(
        JSON.stringify({
          code: 200,
          results: Array.from({ length: 100 }, (_, i) => ({
            type: "status",
            id: String(i + 1),
          })),
          cursor: { bottom: "third" },
        }),
      );
    },
    "next/+ =",
    1000,
  );
  assert.equal(result.nextPageCursor, "third");
  assert.equal(result.relatedTargets.length, 100);
  attachTimeline(result, {
    code: 200,
    results: [],
    cursor: { bottom: "stale" },
  });
  assert.equal(result.nextPageCursor, "");
});

test("timeline collection keeps whole pages, deduplicates and resumes after the last page", async () => {
  const { collectTimeline } = await import("./profile.js");
  const result = normalizeProfile(user, user.id, "fxtwitter");
  const cursors: string[] = [];
  await collectTimeline(result, async (cursor) => {
    cursors.push(cursor);
    const page = cursors.length;
    return {
      code: 200,
      results: Array.from({ length: 18 }, (_, i) => ({
        type: "status",
        id: i === 0 ? "1" : String(page * 100 + i),
      })),
      cursor: { bottom: `page-${page + 1}` },
    };
  });
  assert.equal(cursors.length, 6);
  assert.equal(result.relatedTargets.length, 103);
  assert.equal(result.nextPageCursor, "page-7");
});

test("timeline collection preserves progress when a later request fails", async () => {
  const { collectTimeline } = await import("./profile.js");
  const result = normalizeProfile(user, user.id, "fxtwitter");
  await assert.rejects(
    collectTimeline(result, async (cursor) => {
      if (cursor) throw new Error("upstream unavailable");
      return {
        code: 200,
        results: [{ type: "status", id: "1" }],
        cursor: { bottom: "retry-here" },
      };
    }),
  );
  assert.equal(result.relatedTargets.length, 1);
  assert.equal(result.nextPageCursor, "retry-here");
});

test("timeline collection stops at end or a cursor cycle without dropping posts", async () => {
  const { collectTimeline } = await import("./profile.js");
  for (const bottom of ["", "start"]) {
    const result = normalizeProfile(user, user.id, "fxtwitter");
    let calls = 0;
    await collectTimeline(
      result,
      async () => {
        calls++;
        return {
          code: 200,
          results: [{ type: "status", id: "1" }],
          cursor: { bottom },
        };
      },
      "start",
    );
    assert.equal(calls, 1);
    assert.equal(result.relatedTargets.length, 1);
    assert.equal(result.nextPageCursor, "");
  }
});

test("banner cache identity uses the complete URL", () => {
  const profile = {
    ...user,
    banner_url: "https://pbs.twimg.com/profile_banners/123/456?size=large",
  };
  const key = () =>
    normalizeProfile(profile, user.id, "fxtwitter").resources.find(
      (r) => r.purpose === "banner",
    )!.immutableKey;
  const original = key();
  assert.equal(original, `x:banner:${profile.banner_url}`);
  assert.equal(key(), original);
  profile.banner_url += "&version=2";
  assert.notEqual(key(), original);
});
