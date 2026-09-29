import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedRequest, localURL } from "./dev-web.mjs";

test("preview only targets loopback HTTP APIs", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(localURL(`http://${host}:8080`), `http://${host}:8080`);
  for (const url of [
    "https://example.com",
    "http://192.168.1.1",
    "http://localhost.evil.test",
    "http://user:secret@localhost",
    "http://localhost/v1",
    "http://localhost?token=x",
  ])
    assert.throws(() => localURL(url));
});
test("preview blocks cross-site and rebound hosts before adding its session", () => {
  const headers = { host: "127.0.0.1:5174" };
  assert.equal(allowedRequest({ headers }), true);
  assert.equal(
    allowedRequest({
      headers: {
        ...headers,
        origin: "http://127.0.0.1:5174",
        "sec-fetch-site": "same-origin",
      },
    }),
    true,
  );
  for (const extra of [
    { origin: "https://evil.test" },
    { origin: "null" },
    { origin: "http://127.0.0.1:9999" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { host: "evil.test:5174" },
    { host: undefined },
  ])
    assert.equal(allowedRequest({ headers: { ...headers, ...extra } }), false);
});

test("separator preserves Vite CLI arguments verbatim", async () => {
  const { splitArguments, previewArguments } = await import("./dev-web.mjs");
  assert.deepEqual(
    splitArguments([
      "--tenant",
      "fixture",
      "--",
      "--host",
      "--port",
      "5180",
      "--strictPort",
    ]),
    {
      own: ["--tenant", "fixture"],
      vite: ["--host", "--port", "5180", "--strictPort"],
    },
  );
  assert.deepEqual(splitArguments(["--port", "5174"]), {
    own: ["--port", "5174"],
    vite: [],
  });
  assert.deepEqual(
    previewArguments([
      "--host",
      "0.0.0.0",
      "--config=custom.ts",
      "--mode",
      "test",
      "--force",
    ]),
    {
      forwarded: ["--host", "0.0.0.0", "--mode", "test", "--force"],
      config: "custom.ts",
    },
  );
  assert.throws(() => previewArguments(["--config"]));
});

test("explicit --host permits network IPs but retains same-origin protection", () => {
  const headers = {
    host: "192.168.1.50:5180",
    origin: "http://192.168.1.50:5180",
  };
  assert.equal(allowedRequest({ headers }), false);
  for (const host of [true, "0.0.0.0", "192.168.1.50"]) {
    assert.equal(allowedRequest({ headers }, host), true);
    assert.equal(
      allowedRequest(
        { headers: { ...headers, origin: "https://evil.test" } },
        host,
      ),
      false,
    );
    assert.equal(
      allowedRequest({ headers: { ...headers, host: "evil.test:5180" } }, host),
      false,
    );
  }
  assert.equal(
    allowedRequest(
      { headers: { host: "[fd00::1]:5180", origin: "http://[fd00::1]:5180" } },
      "::",
    ),
    true,
  );
});
