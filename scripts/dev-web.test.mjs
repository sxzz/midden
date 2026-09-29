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
