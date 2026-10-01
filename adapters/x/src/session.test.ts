import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "@grpc/grpc-js";
import {
  accountTransport,
  checkSession,
  checkSessionAccess,
  parseSessionResult,
} from "./session.js";
import { Visibility } from "./generated/api/adapter/v1/adapter.js";

const credential = { authToken: "a".repeat(40), csrfToken: "b".repeat(64) };
const viewer = (id = "900000000000000002") => ({
  data: {
    viewer: {
      is_tfe_restricted_session: false,
      user_results: {
        result: {
          __typename: "User",
          rest_id: id,
          core: { screen_name: "fixture" },
        },
      },
    },
  },
});

test("Viewer verifies the session owner directly, preserving large string IDs", async () => {
  let calls = 0;
  const result = await checkSession(
    credential,
    AbortSignal.timeout(1000),
    async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.x.com");
      assert.ok(url.pathname.endsWith("/Viewer"));
      const h = new Headers(init?.headers);
      assert.equal(
        h.get("cookie"),
        `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      );
      assert.equal(h.get("x-client-transaction-id"), null);
      assert.equal(init?.redirect, "error");
      return Response.json(viewer());
    },
  );
  assert.deepEqual(result, {
    accountId: "900000000000000002",
    username: "fixture",
  });
  assert.equal(calls, 1);
});

test("post GraphQL never needs the homepage or an inherited transaction ID", async () => {
  const calls: string[] = [];
  const transport = accountTransport(
    credential,
    AbortSignal.timeout(1000),
    async (input, init) => {
      calls.push(String(input));
      assert.equal(
        new Headers(init?.headers).get("x-client-transaction-id"),
        null,
      );
      return Response.json({
        data: { tweetResult: { result: { __typename: "Tweet" } } },
      });
    },
  )!;
  await transport.fetch(
    "https://api.x.com/graphql/fixture/TweetResultByRestId",
    { headers: { "x-client-transaction-id": "stale" } },
  );
  assert.deepEqual(calls, [
    "https://api.x.com/graphql/fixture/TweetResultByRestId",
  ]);
});

test("required signing does not silently proceed after a homepage challenge", async () => {
  const calls: string[] = [];
  const transport = accountTransport(
    credential,
    AbortSignal.timeout(1000),
    async (input) => {
      calls.push(String(input));
      return new Response("challenge", {
        status: 403,
        headers: { "cf-mitigated": "challenge" },
      });
    },
  )!;
  await assert.rejects(
    () => transport.fetch("https://api.x.com/graphql/fixture/SearchTimeline"),
    (e: any) =>
      e.code === status.UNAVAILABLE &&
      e.message.includes("browser verification"),
  );
  assert.deepEqual(calls, ["https://x.com/home"]);
});

test("verification rejects errors and missing identity without fallback", async () => {
  const restricted = viewer();
  restricted.data.viewer.is_tfe_restricted_session = true;
  for (const [response, code] of [
    [
      Response.json({ errors: [{ code: 32 }, { code: 215 }] }),
      status.UNAUTHENTICATED,
    ],
    [new Response("", { status: 401 }), status.UNAUTHENTICATED],
    [
      new Response("challenge", {
        status: 403,
        headers: { "cf-mitigated": "challenge" },
      }),
      status.UNAVAILABLE,
    ],
    [
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
      status.UNAVAILABLE,
    ],
    [new Response("", { status: 404 }), status.FAILED_PRECONDITION],
    [Response.json(restricted), status.PERMISSION_DENIED],
    [
      Response.json({ data: { tweetResult: { result: { rest_id: "123" } } } }),
      status.FAILED_PRECONDITION,
    ],
    [Response.json(viewer("not-an-id")), status.FAILED_PRECONDITION],
    [new Response("bad json"), status.UNAVAILABLE],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      () =>
        checkSession(credential, AbortSignal.timeout(1000), async () => {
          calls++;
          return response;
        }),
      (e: any) => e.code === code,
    );
    assert.equal(calls, 1);
  }
});

test("parallel Viewer requests keep account credentials and results separate", async () => {
  const fetcher: typeof fetch = async (_url, init) =>
    Response.json(
      viewer(
        new Headers(init?.headers).get("cookie")!.includes(credential.authToken)
          ? "123"
          : "456",
      ),
    );
  const results = await Promise.all([
    checkSession(credential, AbortSignal.timeout(1000), fetcher),
    checkSession(
      { ...credential, authToken: "c".repeat(40) },
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ]);
  assert.deepEqual(
    results.map((r) => r.accountId),
    ["123", "456"],
  );
});

const tweet = (id: string, author: string, protectedFlag = false): any => ({
  __typename: "Tweet",
  rest_id: id,
  core: {
    user_results: {
      result: {
        __typename: "User",
        rest_id: author,
        legacy: {
          screen_name: `user${author}`,
          name: `User ${author}`,
          protected: protectedFlag,
        },
      },
    },
  },
  legacy: {
    id_str: id,
    full_text: `post ${id}`,
    created_at: "Mon Jan 01 00:00:00 +0000 2024",
    entities: { urls: [], hashtags: [], user_mentions: [] },
    extended_entities: { media: [] },
  },
});
const ref = (externalId: string) => ({
  platform: "x",
  kind: "post",
  objectScope: "",
  externalId,
});
const quoting = (quoted: any) => {
  const raw = tweet("900123", "42");
  raw.legacy.quoted_status_id_str = "900124";
  raw.quoted_status_result = { result: quoted };
  return raw;
};
async function access(result: any, embedded = [ref("900124")]) {
  const calls: string[] = [];
  const response = await checkSessionAccess(
    "900123",
    embedded,
    credential,
    AbortSignal.timeout(1000),
    async (input) => {
      calls.push(new URL(String(input)).pathname);
      return Response.json({ data: { tweetResult: result ? { result } : {} } });
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.endsWith("/TweetResultByRestId"));
  return response;
}

test("access check reads a public target and its visible quote with one request", async () => {
  const result = await access(quoting(tweet("900124", "43")), [
    ref("900124"),
    ref("900125"),
    { ...ref("900124"), kind: "profile" },
  ]);
  assert.equal(result.visibility, Visibility.VISIBILITY_PUBLIC);
  assert.deepEqual(result.accessible, [ref("900123"), ref("900124")]);
});

test("access check classifies a readable protected target as private", async () => {
  const result = await access(tweet("900123", "42", true), []);
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE);
  assert.deepEqual(result.accessible, [ref("900123")]);
  const wrapped = await access(
    { __typename: "TweetWithVisibilityResults", tweet: tweet("900123", "42") },
    [],
  );
  assert.equal(wrapped.visibility, Visibility.VISIBILITY_PUBLIC);
});

test("access check omits an embedded quote the account cannot read", async () => {
  for (const quoted of [
    { __typename: "TweetUnavailable", reason: "Protected" },
    { __typename: "TweetTombstone", tombstone: { text: { text: "gone" } } },
    { __typename: "TweetUnavailable", rest_id: "900124" },
  ]) {
    const result = await access(quoting(quoted));
    assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE);
    assert.deepEqual(result.accessible, [ref("900123")]);
  }
  const hidden = await access(quoting(tweet("900124", "43", true)));
  assert.equal(hidden.visibility, Visibility.VISIBILITY_PRIVATE);
  assert.deepEqual(hidden.accessible, [ref("900123"), ref("900124")]);
});

test("access check maps unavailable targets and mismatched IDs like Fetch", async () => {
  for (const [result, code] of [
    [
      { __typename: "TweetUnavailable", reason: "Protected" },
      status.PERMISSION_DENIED,
    ],
    [
      {
        __typename: "TweetWithVisibilityResults",
        tweet: { __typename: "TweetTombstone" },
      },
      status.PERMISSION_DENIED,
    ],
    [undefined, status.PERMISSION_DENIED],
    [tweet("900999", "42"), status.UNAVAILABLE],
  ] as const) {
    await assert.rejects(
      () => access(result, []),
      (e: any) => e.code === code,
    );
  }
  // Atmosphere rejects a bare root tombstone before classification, exactly as
  // for Fetch; the server reports that as a transient UNAVAILABLE.
  await assert.rejects(
    () => access({ __typename: "TweetTombstone", tombstone: {} }, []),
    /Invalid upstream response/,
  );
  for (const [response, code] of [
    [new Response("", { status: 401 }), status.UNAUTHENTICATED],
    [
      new Response("", { status: 429, headers: { "retry-after": "15" } }),
      status.UNAVAILABLE,
    ],
  ] as const)
    await assert.rejects(
      () =>
        checkSessionAccess(
          "900123",
          [],
          credential,
          AbortSignal.timeout(1000),
          async () => response,
        ),
      (e: any) =>
        e.code === code &&
        (code !== status.UNAVAILABLE ||
          e.metadata.get("retry-after")[0] === "15"),
    );
});

test("session Fetch lists embedded posts lacking public evidence", async () => {
  const host = {
    t: (key: string) => key,
    twitterProxy: {
      fetch: async () => {
        throw new Error("Unexpected extra request");
      },
    },
  };
  const visible = await parseSessionResult(
    "900123",
    quoting(tweet("900124", "43")),
    host,
  );
  assert.deepEqual(visible.restrictedTargets, []);
  const restricted = await parseSessionResult(
    "900123",
    quoting(tweet("900124", "43", true)),
    host,
  );
  assert.equal(restricted.visibility, Visibility.VISIBILITY_PRIVATE);
  assert.deepEqual(restricted.restrictedTargets, [ref("900124")]);
  const missingFlag = quoting(tweet("900124", "43"));
  delete missingFlag.quoted_status_result.result.core.user_results.result.legacy
    .protected;
  assert.deepEqual(
    (await parseSessionResult("900123", missingFlag, host)).restrictedTargets,
    [ref("900124")],
  );
  // A protected root alone does not mark its public quote restricted.
  const root = quoting(tweet("900124", "43"));
  root.core.user_results.result.legacy.protected = true;
  const own = await parseSessionResult("900123", root, host);
  assert.equal(own.visibility, Visibility.VISIBILITY_PRIVATE);
  assert.deepEqual(own.restrictedTargets, []);
});
