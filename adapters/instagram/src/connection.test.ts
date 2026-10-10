import assert from "node:assert/strict";
import test from "node:test";
import { status } from "@grpc/grpc-js";
import { InstagramClient } from "./client.js";
import { ProviderError } from "./errors.js";

const viewer = { id: "77", username: "fixture.name" };
const page = (definitions: unknown[]) =>
  `<script data-sjs type="application/json">${JSON.stringify({
    require: [["ScheduledServerJS", [], { __bbox: { define: definitions } }]],
  })}</script>`;
const definition = (data: unknown, name = "PolarisViewer") => [
  name,
  [],
  { data },
  0,
];

test("verifies a browser session using its authenticated web viewer", async () => {
  let calls = 0;
  const client = new InstagramClient(
    new AbortController().signal,
    { sessionId: "77%3Afixture", userId: "77", csrfToken: "csrf" },
    async (input, init) => {
      calls++;
      assert.equal(String(input), "https://www.instagram.com/accounts/edit/");
      assert.equal(init?.redirect, "manual");
      assert.equal(
        new Headers(init?.headers).get("cookie"),
        "sessionid=77%3Afixture; ds_user_id=77; csrftoken=csrf",
      );
      return new Response(
        page([
          definition({ id: "88", username: "other" }, "UnrelatedProfile"),
          definition(viewer),
        ]),
      );
    },
  );
  assert.deepEqual(await client.checkConnection(), {
    accountId: "77",
    username: "fixture.name",
  });
  assert.equal(calls, 1);
  assert.equal(client.sources.length, 0);
});

test("does not require ds_user_id when the web viewer proves the session identity", async () => {
  const client = new InstagramClient(
    new AbortController().signal,
    { sessionId: "session" },
    async () => new Response(page([definition(viewer)])),
  );
  assert.equal((await client.checkConnection()).accountId, "77");
});

test("rejects logged-out pages, arbitrary profiles, malformed viewers and mismatched cookies", async () => {
  for (const [html, userId] of [
    ["<html>Login</html>", "77"],
    [page([definition(viewer, "UnrelatedProfile")]), "77"],
    [page([definition({ id: "77" })]), "77"],
    [page([definition({ id: "invalid", username: "fixture.name" })]), "77"],
    [page([definition(viewer)]), "88"],
    ['<script type="application/json" data-sjs>{broken}</script>', "77"],
  ]) {
    const client = new InstagramClient(
      new AbortController().signal,
      { sessionId: "session", userId },
      async () => new Response(html),
    );
    await assert.rejects(
      client.checkConnection(),
      (error: unknown) =>
        error instanceof ProviderError && error.code === status.UNAUTHENTICATED,
    );
  }
});

test("preserves web verification challenges and rate limits without retrying", async () => {
  for (const [http, code] of [
    [302, status.UNAUTHENTICATED],
    [403, status.PERMISSION_DENIED],
    [429, status.RESOURCE_EXHAUSTED],
  ]) {
    let calls = 0;
    const client = new InstagramClient(
      new AbortController().signal,
      { sessionId: "session" },
      async () => {
        calls++;
        return new Response(null, { status: http });
      },
    );
    await assert.rejects(
      client.checkConnection(),
      (error: unknown) => error instanceof ProviderError && error.code === code,
    );
    assert.equal(calls, 1);
  }
});
