import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "@grpc/grpc-js";
import { accountBootstrap, bootstrapIdentity } from "./bootstrap.js";

const credential = { authToken: "a".repeat(40), csrfToken: "b".repeat(64) };
function page(id = "123", username = "fixture") {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({ session: { isLoaded: true, user_id: id }, entities: { users: { entities: { [id]: { screen_name: username, description: '} \\" { ;window.other=1' } } } } })};window.other=1;</script>`;
}

test("verify the authenticated session owner from homepage bootstrap", async () => {
  assert.deepEqual(bootstrapIdentity(page()), {
    accountId: "123",
    username: "fixture",
  });
  let calls = 0;
  const result = await accountBootstrap(
    credential,
    AbortSignal.timeout(1000),
    async (url, init) => {
      calls++;
      assert.equal(url, "https://x.com/home");
      assert.equal(init?.redirect, "manual");
      assert.equal(
        new Headers(init?.headers).get("cookie"),
        `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      );
      return new Response(page());
    },
  );
  assert.deepEqual(result.identity, { accountId: "123", username: "fixture" });
  assert.equal(calls, 1);
  for (const html of [
    "<html>login</html>",
    "<script>window.__INITIAL_STATE__={bad}</script>",
    page().replace('"user_id":"123"', '"user_id":"456"'),
    page().replace('"isLoaded":true', '"isLoaded":false'),
  ]) {
    assert.throws(
      () => bootstrapIdentity(html),
      (e: any) => e.code === status.FAILED_PRECONDITION,
    );
  }
});

test("verification distinguishes expired cookies, interface drift and throttling", async () => {
  for (const [response, code] of [
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://x.com/i/flow/login" },
      }),
      status.UNAUTHENTICATED,
    ],
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://other.test/" },
      }),
      status.UNAVAILABLE,
    ],
    [new Response("", { status: 401 }), status.UNAUTHENTICATED],
    [new Response("", { status: 404 }), status.FAILED_PRECONDITION],
    [
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
      status.UNAVAILABLE,
    ],
    [new Response("a".repeat((2 << 20) + 1)), status.UNAVAILABLE],
  ] as const) {
    await assert.rejects(
      () =>
        accountBootstrap(
          credential,
          AbortSignal.timeout(1000),
          async () => response,
        ),
      (e: any) => e.code === code,
    );
  }
});

test("parallel verification keeps each account's cookie and identity separate", async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const cookie = new Headers(init?.headers).get("cookie")!;
    return new Response(
      page(
        cookie.includes("auth_token=" + credential.authToken) ? "123" : "456",
      ),
    );
  };
  const results = await Promise.all([
    accountBootstrap(credential, AbortSignal.timeout(1000), fetcher),
    accountBootstrap(
      { ...credential, authToken: "c".repeat(40) },
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ]);
  assert.deepEqual(
    results.map((x) => x.identity.accountId),
    ["123", "456"],
  );
});
