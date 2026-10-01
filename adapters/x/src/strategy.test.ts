import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureStrategy } from "./strategy.js";
import {
  normalizeProfile,
  fetchSessionTimeline,
  fetchPublicTimeline,
} from "./profile.js";
import {
  FetchRequest,
  FetchResponse,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";
const credential = { authToken: "a".repeat(40), csrfToken: "b".repeat(64) };
const request = (kind = "post", providerId = "x-session") =>
  FetchRequest.fromPartial({
    url:
      kind === "post"
        ? "https://x.com/fixture/status/42"
        : "https://x.com/fixture",
    externalId: kind === "post" ? "42" : "handle:fixture",
    platform: "x",
    kind,
    providerId,
  });
const user = {
  id: "123",
  type: "profile",
  name: "Fixture",
  screen_name: "fixture",
  protected: false,
};
const post = (providerId: string) =>
  FetchResponse.fromPartial({
    externalId: "42",
    providerId,
    text: "Body",
    visibility: Visibility.VISIBILITY_PUBLIC,
    graph: {
      root: "post",
      entities: [
        {
          key: "post",
          externalId: "42",
          type: "x.post",
          dataJson: Buffer.from('{"text":"Body"}'),
        },
        {
          key: "author",
          externalId: "123",
          type: "x.profile",
          dataJson: Buffer.from("{}"),
        },
      ],
      relations: [{ source: "post", target: "author", type: "authored_by" }],
    },
  });
test("public profiles precede post selection, even when an account is selected; cache expires after one minute", async () => {
  let now = 0;
  const calls: string[] = [];
  const strategy = new CaptureStrategy(
    async () => {
      calls.push("public-post");
      return post("fxtwitter");
    },
    async (id) => {
      calls.push("public-profile");
      return normalizeProfile(user, id, "fxtwitter");
    },
    async () => {
      throw new Error("must not use account");
    },
    undefined,
    () => now,
  );
  const r = await strategy.fetch(
    request(),
    AbortSignal.timeout(1000),
    credential,
  );
  assert.deepEqual(calls, ["public-profile", "public-post"]);
  assert.equal(r.providerId, "x-session");
  now = 59_999;
  await strategy.fetch(request(), AbortSignal.timeout(1000), credential);
  assert.equal(calls.filter((c) => c === "public-profile").length, 1);
  now = 60_000;
  await strategy.fetch(request(), AbortSignal.timeout(1000), credential);
  assert.equal(calls.filter((c) => c === "public-profile").length, 2);
  assert.equal(r.relatedTargets[0].refreshAfterSeconds, 60);
});
test("protected posts use the selected account after public profile lookup", async () => {
  const calls: string[] = [];
  const strategy = new CaptureStrategy(
    async () => {
      throw new Error("must not fetch public post");
    },
    async (id) => {
      calls.push("public-profile");
      return normalizeProfile({ ...user, protected: true }, id, "fxtwitter");
    },
    async () => {
      calls.push("account-post");
      return {
        ...post("x-session"),
        visibility: Visibility.VISIBILITY_PRIVATE,
      };
    },
  );
  const r = await strategy.fetch(
    request(),
    AbortSignal.timeout(1000),
    credential,
  );
  assert.deepEqual(calls, ["public-profile", "account-post"]);
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE);
  await assert.rejects(
    () =>
      strategy.fetch(request("post", "fxtwitter"), AbortSignal.timeout(1000)),
    /受保护/,
  );
});
test("explicit profile always refreshes and routes timeline by protection", async () => {
  let profiles = 0,
    publicTimelines = 0,
    privateTimelines = 0,
    protectedUser = false;
  const strategy = new CaptureStrategy(
    undefined,
    async (id) => {
      profiles++;
      return normalizeProfile(
        { ...user, protected: protectedUser },
        id,
        "fxtwitter",
      );
    },
    undefined,
    async () => {
      privateTimelines++;
    },
  );
  strategy.timeline = async () => {
    publicTimelines++;
  };
  await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  assert.equal(profiles, 2);
  assert.equal(publicTimelines, 2);
  assert.equal(privateTimelines, 0);
  protectedUser = true;
  const r = await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  assert.equal(privateTimelines, 1);
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE);
  await strategy.fetch(
    { ...request("profile"), externalId: "123", automatic: true },
    AbortSignal.timeout(1000),
    credential,
  );
  assert.equal(profiles, 3);
  assert.equal(privateTimelines, 1);
});
test("ID-only posts discover their author, then refresh profile without fetching post twice", async () => {
  const calls: string[] = [];
  const strategy = new CaptureStrategy(
    async () => {
      calls.push("post-discovery");
      return post("fxtwitter");
    },
    async (id) => {
      calls.push("profile");
      assert.equal(id, "123");
      return normalizeProfile(user, id, "fxtwitter");
    },
  );
  await strategy.fetch(
    { ...request("post", "fxtwitter"), url: "https://x.com/i/web/status/42" },
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(calls, ["post-discovery", "profile"]);
});
test("private timeline requests count 100 and retains raw response privately", async () => {
  const urls: string[] = [];
  const raw = JSON.stringify({
    data: {
      user: { result: { timeline_v2: { timeline: { instructions: [] } } } },
    },
  });
  const r = normalizeProfile({ ...user, protected: true }, "123", "fxtwitter");
  await fetchSessionTimeline(
    r,
    credential,
    AbortSignal.timeout(2000),
    async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.href);
      assert.equal(JSON.parse(url.searchParams.get("variables")!).count, 100);
      assert.ok(new Headers(init?.headers).get("cookie"));
      return new Response(raw, {
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.ok(urls.length > 0);
  assert.ok(r.sourceResponses.length > 0);
  assert.ok(
    r.sourceResponses.every(
      (s) => s.visibility === Visibility.VISIBILITY_PRIVATE,
    ),
  );
  assert.equal(Buffer.from(r.sourceResponses[0].body).toString(), raw);
});

test("ID-only public 401 falls back to selected account then refreshes profile publicly", async () => {
  const { responseError } = await import("./provider.js");
  const calls: string[] = [];
  const strategy = new CaptureStrategy(
    async () => {
      calls.push("public-post");
      throw responseError(401);
    },
    async (id) => {
      calls.push("public-profile");
      return normalizeProfile({ ...user, protected: true }, id, "fxtwitter");
    },
    async () => {
      calls.push("private-post");
      return {
        ...post("x-session"),
        visibility: Visibility.VISIBILITY_PRIVATE,
      };
    },
  );
  const r = await strategy.fetch(
    { ...request(), url: "https://x.com/i/web/status/42" },
    AbortSignal.timeout(1000),
    credential,
  );
  assert.deepEqual(calls, ["public-post", "private-post", "public-profile"]);
  assert.equal(r.visibility, Visibility.VISIBILITY_PRIVATE);
  for (const code of [403, 404, 429, 500]) {
    let privateCalls = 0;
    const failing = new CaptureStrategy(
      async () => {
        throw responseError(code);
      },
      undefined,
      async () => {
        privateCalls++;
        return post("x-session");
      },
    );
    await assert.rejects(() =>
      failing.fetch(
        { ...request(), url: "https://x.com/i/web/status/42" },
        AbortSignal.timeout(1000),
        credential,
      ),
    );
    assert.equal(privateCalls, 0);
  }
});

test("profile continuation is bound to user and public/private source", async () => {
  const strategy = new CaptureStrategy(undefined, async (id) =>
    normalizeProfile(user, id, "fxtwitter"),
  );
  const cursors: string[] = [];
  strategy.timeline = async (result, _signal, _fetcher, cursor = "") => {
    cursors.push(cursor);
    result.nextPageCursor = cursor ? "" : "page-two";
  };
  const first = await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  const second = await strategy.fetch(
    { ...request("profile"), pageCursor: first.nextPageCursor },
    AbortSignal.timeout(1000),
    credential,
  );
  assert.deepEqual(cursors, ["", "page-two"]);
  assert.equal(first.maxBatchSize, 1000);
  assert.equal(second.nextPageCursor, "");
  for (const token of [
    "invalid",
    JSON.stringify({ user: "other", mode: "public", cursor: "page-two" }),
    JSON.stringify({ user: "123", mode: "private", cursor: "page-two" }),
  ]) {
    await assert.rejects(
      strategy.fetch(
        { ...request("profile"), pageCursor: token },
        AbortSignal.timeout(1000),
        credential,
      ),
    );
  }
  strategy.timeline = async (result) => {
    result.nextPageCursor = "page-two";
  };
  assert.equal(
    (
      await strategy.fetch(
        { ...request("profile"), pageCursor: first.nextPageCursor },
        AbortSignal.timeout(1000),
        credential,
      )
    ).nextPageCursor,
    "",
  );
});

test("protected continuation requests 100 and never advertises bulk collection", async () => {
  const strategy = new CaptureStrategy(
    undefined,
    async (id) =>
      normalizeProfile({ ...user, protected: true }, id, "fxtwitter"),
    undefined,
    async (
      result,
      _credential,
      signal,
      _fetcher,
      cursor = "",
      pageSize = 0,
    ) => {
      await fetchSessionTimeline(
        result,
        credential,
        signal,
        async (input) => {
          const variables = JSON.parse(
            new URL(String(input)).searchParams.get("variables")!,
          );
          assert.equal(variables.count, 100);
          assert.equal(variables.cursor, "protected-next");
          return new Response(
            JSON.stringify({
              data: {
                user: {
                  result: { timeline_v2: { timeline: { instructions: [] } } },
                },
              },
            }),
          );
        },
        cursor,
        pageSize,
      );
    },
  );
  const result = await strategy.fetch(
    {
      ...request("profile"),
      pageCursor: JSON.stringify({
        user: "123",
        mode: "private",
        cursor: "protected-next",
      }),
    },
    AbortSignal.timeout(2000),
    credential,
  );
  assert.equal(result.maxBatchSize, 0);
});

test("public timeline always uses FxTwitter public instance with a selected account", async () => {
  let privateCalls = 0;
  const strategy = new CaptureStrategy(
    undefined,
    async (id) => normalizeProfile(user, id, "fxtwitter"),
    undefined,
    async () => {
      privateCalls++;
    },
  );
  let responseStatus = 200;
  const requests: URL[] = [];
  strategy.timeline = async (result, signal, _fetcher, cursor, pageSize) => {
    await fetchPublicTimeline(
      result,
      signal,
      async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assert.equal(url.origin, "https://api.fxtwitter.com");
        assert.equal(url.pathname, "/2/profile/id:123/statuses");
        assert.equal(url.searchParams.get("count"), "100");
        assert.equal(new Headers(init?.headers).has("cookie"), false);
        return new Response(
          JSON.stringify({
            code: 200,
            results: Array.from({ length: 100 }, (_, i) => ({
              type: "status",
              id: String(i + 1),
            })),
            cursor: { bottom: "next" },
          }),
          { status: responseStatus },
        );
      },
      cursor,
      pageSize,
    );
  };
  const first = await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  for (const pageSize of [0, 1000]) {
    await strategy.fetch(
      { ...request("profile"), pageCursor: first.nextPageCursor, pageSize },
      AbortSignal.timeout(1000),
      credential,
    );
  }
  responseStatus = 401;
  const failed = await strategy.fetch(
    request("profile"),
    AbortSignal.timeout(1000),
    credential,
  );
  assert.equal(failed.incomplete, true);
  assert.deepEqual(
    requests.map((url) => url.searchParams.get("cursor")),
    [null, "next", "next", null],
  );
  assert.equal(privateCalls, 0);
});

test("full author hydration preserves post mentions and captures mentions from the richer bio", async () => {
  const { normalize } = await import("./provider.js");
  const strategy = new CaptureStrategy(
    async () =>
      normalize(
        {
          type: "status",
          id: "42",
          text: "Hi @Mentioned",
          author: user,
          media: { all: [] },
        },
        "42",
        "fxtwitter",
        Visibility.VISIBILITY_PUBLIC,
      ),
    async (id) =>
      normalizeProfile(
        { ...user, description: "With @BioFriend" },
        id,
        "fxtwitter",
      ),
  );
  const result = await strategy.fetch(
    request("post", "fxtwitter"),
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(
    new Set(result.relatedTargets.map((target) => target.url)),
    new Set([
      "https://x.com/i/user/123",
      "https://x.com/mentioned",
      "https://x.com/biofriend",
    ]),
  );
  assert.equal(
    result.graph!.relations.filter((relation) => relation.type === "mentions")
      .length,
    2,
  );
});
