import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "@grpc/grpc-js";
import { accountTransport, checkSession } from "./session.js";

const credential = { authToken: "a".repeat(40), csrfToken: "b".repeat(64) };
const viewer = (id = "1657726063806660609") => ({
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
    accountId: "1657726063806660609",
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
