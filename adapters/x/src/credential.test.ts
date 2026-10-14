import test from "node:test";
import assert from "node:assert/strict";
import { prepareCredential, decodeCredential } from "./credential.js";
import { resolveTarget } from "./resolve.js";

test("adapter owns cookie normalization and opaque credentials", () => {
  const authToken = "a".repeat(40),
    csrfToken = "b".repeat(64);
  const input = Buffer.from(
    `other=ignored; auth_token=${authToken}; ct0=${csrfToken};`,
  ).toString("base64");
  for (const text of [
    input,
    input.replace(/=+$/, ""),
    JSON.stringify({ auth_token: authToken, csrf_token: csrfToken }),
  ]) {
    assert.deepEqual(decodeCredential(prepareCredential(Buffer.from(text))), {
      authToken,
      csrfToken,
    });
  }
  for (const cookie of [
    "auth_token=short; ct0=short",
    `auth_token=${authToken};auth_token=${authToken};ct0=${csrfToken}`,
    `auth_token=${authToken};ct0=${csrfToken}\r\n`,
  ]) {
    assert.throws(() =>
      prepareCredential(Buffer.from(Buffer.from(cookie).toString("base64"))),
    );
  }
  for (const input of ["invalid!", "{}", "eA==="])
    assert.throws(() => prepareCredential(Buffer.from(input)));
});
test("adapter owns X target identity", () => {
  for (const host of [
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "www.x.com",
  ]) {
    const r = resolveTarget(`https://${host}/fixture/status/123/photo/2?q=1`);
    assert.deepEqual(r, {
      url: "https://x.com/fixture/status/123",
      platform: "x",
      kind: "post",
      objectScope: "",
      externalId: "123",
      refreshOnSubmit: false,
      collection: false,
    });
  }
  // FxEmbed mirrors name the same post, with an optional view and language.
  for (const input of [
    "https://fxtwitter.com/fixture/status/123",
    "https://fixupx.com/fixture/status/123/en",
    "https://d.fxtwitter.com/fixture/status/123/photo/1",
    "https://g.fixupx.com/fixture/status/123/zh-CN/",
  ])
    assert.equal(resolveTarget(input).url, "https://x.com/fixture/status/123");
  assert.equal(
    resolveTarget("https://fxtwitter.com/Fixture").externalId,
    "handle:fixture",
  );
  for (const input of [
    "https://x.com/fixture/status/123/en",
    "https://api.fxtwitter.com/fixture/status/123",
    "https://fxtwitter.com.evil.test/a/status/123",
    "https://x.com.evil.test/a/status/123",
    "https://user@x.com/a/status/123",
    "file:///a/status/123",
    "https://x.com/a/status/no",
  ])
    assert.throws(() => resolveTarget(input));
});
