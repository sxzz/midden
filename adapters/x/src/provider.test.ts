import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import {
  status,
  credentials,
  ServerCredentials,
  Metadata,
} from "@grpc/grpc-js";
import {
  normalize,
  fetchPublic,
  ProviderError,
  responseError,
} from "./provider.js";
import {
  visibilityOf,
  accountTransport,
  rawIsPublic,
  parseSessionResult,
} from "./session.js";
import {
  Visibility,
  AdapterClient,
} from "./generated/api/adapter/v1/adapter.js";
import { createServer } from "./server.js";
const fixture = JSON.parse(
  readFileSync(new URL("./testdata/post.json", import.meta.url), "utf8"),
);
const credential = { authToken: "a".repeat(40), csrfToken: "b".repeat(64) };
test("public fixture preserves text, alt text and highest quality media", () => {
  const post = structuredClone(fixture.status);
  post.media.all.push({
    id: "video-1",
    type: "video",
    url: "https://media.test/low.mp4",
    altText: "video description",
    sensitive: true,
    formats: [
      {
        container: "mp4",
        width: 640,
        height: 480,
        bitrate: 1000,
        url: "https://media.test/low.mp4",
      },
      {
        container: "mp4",
        width: 1920,
        height: 1080,
        bitrate: 3000,
        url: "https://media.test/high.mp4",
      },
    ],
  });
  const result = normalize(
    post,
    post.id,
    "fxtwitter",
    Visibility.VISIBILITY_PUBLIC,
  );
  assert.ok(result.text.includes("合成测试"));
  assert.equal(
    result.summary,
    `${post.author.name}：${result.text}[图片][视频]`,
  );
  const video = result.resources.find((r) => r.kind === "video")!;
  assert.equal(video.url, "https://media.test/high.mp4");
  assert.equal(video.altText, "video description");
  assert.equal(video.sensitive, true);
  assert.ok(video.immutableKey.includes("video-1"));
});
test("private classification is conservative and includes quotes", () => {
  assert.equal(
    visibilityOf({ type: "status", author: { protected: false } }),
    Visibility.VISIBILITY_PUBLIC,
  );
  for (const p of [
    {},
    { type: "status", author: {} },
    { type: "status", author: { protected: true } },
    {
      type: "status",
      author: { protected: false },
      quote: { type: "status", author: { protected: true } },
    },
  ])
    assert.equal(visibilityOf(p), Visibility.VISIBILITY_PRIVATE);
});
test("request-bound accounts cannot mix credentials; errors never retry anonymously", async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    assert.ok(
      new Headers(init?.headers).get("authorization")?.startsWith("Bearer "),
    );
    seen.push(new Headers(init?.headers).get("cookie")!);
    await new Promise((r) => setTimeout(r, 5));
    return Response.json({ id_str: "1" });
  };
  const a = accountTransport(
    credential,
    new AbortController().signal,
    fetcher,
  )!;
  const b = accountTransport(
    { ...credential, authToken: "c".repeat(40) },
    new AbortController().signal,
    fetcher,
  )!;
  await Promise.all([
    a.fetch("https://api.x.com/1.1/account/verify_credentials.json"),
    b.fetch("https://api.x.com/1.1/account/verify_credentials.json"),
  ]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  let count = 0;
  const rejected = accountTransport(
    credential,
    new AbortController().signal,
    async () => {
      count++;
      return new Response("", { status: 401 });
    },
  )!;
  await assert.rejects(
    () =>
      rejected.fetch("https://api.x.com/1.1/account/verify_credentials.json"),
    (e: any) => e.code === status.UNAUTHENTICATED,
  );
  assert.equal(count, 1);
  await assert.rejects(
    () => a.fetch("https://other.test/"),
    (e: any) => e.code === status.FAILED_PRECONDITION,
  );
});
test("public HTTP: no account, malformed JSON, throttling and cancellation", async () => {
  let mode = "valid";
  const server = httpServer((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    if (mode === "invalid") {
      res.end("{");
      return;
    }
    if (mode === "limit") {
      res.writeHead(429, { "retry-after": "15" });
      res.end();
      return;
    }
    if (mode === "slow") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(fixture));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const r = await fetchPublic(
      fixture.status.id,
      new AbortController().signal,
      endpoint,
    );
    assert.equal(r.visibility, Visibility.VISIBILITY_PUBLIC);
    mode = "invalid";
    await assert.rejects(
      () =>
        fetchPublic(fixture.status.id, new AbortController().signal, endpoint),
      ProviderError,
    );
    mode = "limit";
    await assert.rejects(
      () =>
        fetchPublic(fixture.status.id, new AbortController().signal, endpoint),
      (e: any) => e.metadata.get("retry-after")[0] === "15",
    );
    mode = "slow";
    await assert.rejects(() =>
      fetchPublic(fixture.status.id, AbortSignal.timeout(30), endpoint),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("gRPC authentication and zero-account Describe", async () => {
  const server = createServer("fixture-token");
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  const client = new AdapterClient(
    `127.0.0.1:${port}`,
    credentials.createInsecure(),
  );
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) =>
          client.describe({}, (e, v) => (e ? reject(e) : resolve(v))),
        ),
      (e: any) => e.code === status.UNAUTHENTICATED,
    );
    const metadata = new Metadata();
    metadata.set("authorization", "Bearer fixture-token");
    const result: any = await new Promise((resolve, reject) =>
      client.describe({}, metadata, (e, v) => (e ? reject(e) : resolve(v))),
    );
    assert.equal(result.providers[0].id, "fxtwitter");
    assert.equal(result.providers[0].authentication, "none");
    assert.equal(result.providers.length, 2);
    assert.equal(result.protocolVersion, "1.0");
    assert.ok(
      result.providers[0].capabilities.some(
        (c: any) => c.name === "capture.fetch" && c.major === 1,
      ),
    );
    assert.ok(
      !result.providers[0].capabilities.some(
        (c: any) => c.name === "connection.check",
      ),
    );
    assert.ok(
      result.providers[1].capabilities.some(
        (c: any) => c.name === "connection.check" && c.major === 1,
      ),
    );
    await assert.rejects(
      () =>
        new Promise((resolve, reject) =>
          client.checkConnection(
            { providerId: "x-session", credential },
            metadata,
            (e, v) => (e ? reject(e) : resolve(v)),
          ),
        ),
      (e: any) => e.code === status.FAILED_PRECONDITION,
    );
  } finally {
    client.close();
    server.forceShutdown();
  }
});

test("Atmosphere parses authorized protected and public GraphQL fixtures", async () => {
  const raw: any = {
    __typename: "Tweet",
    rest_id: "900123",
    core: {
      user_results: {
        result: {
          __typename: "User",
          rest_id: "42",
          legacy: { screen_name: "fixture", name: "Fixture", protected: true },
        },
      },
    },
    legacy: {
      id_str: "900123",
      full_text: "private fixture text",
      created_at: "Mon Jan 01 00:00:00 +0000 2024",
      entities: { urls: [], hashtags: [], user_mentions: [] },
      extended_entities: { media: [] },
    },
  };
  const host = {
    t: (key: string) => key,
    twitterProxy: {
      fetch: async () => {
        throw new Error("Unexpected extra request");
      },
    },
  };
  let result = await parseSessionResult("900123", structuredClone(raw), host);
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE);
  assert.equal(result.text, "private fixture text");
  raw.core.user_results.result.legacy.protected = false;
  result = await parseSessionResult("900123", structuredClone(raw), host);
  assert.equal(result.visibility, Visibility.VISIBILITY_PUBLIC);
  assert.equal(
    rawIsPublic({ __typename: "TweetWithVisibilityResults", tweet: raw }),
    true,
  );
  const wrapped = {
    __typename: "TweetWithVisibilityResults",
    tweet: structuredClone(raw),
    mediaVisibilityResults: {
      blurred_image_interstitial: {
        opacity: 1,
        text: "Sensitive content",
        title: "Warning",
      },
    },
  };
  assert.equal(rawIsPublic(wrapped), true);
  assert.equal(
    (await parseSessionResult("900123", wrapped, host)).visibility,
    Visibility.VISIBILITY_PUBLIC,
  );
  assert.equal(rawIsPublic({ ...wrapped, limitedActionResults: {} }), false);
  assert.equal(
    rawIsPublic({
      ...wrapped,
      mediaVisibilityResults: { audience_restriction: {} },
    }),
    false,
  );
  assert.equal(
    rawIsPublic({ ...wrapped, mediaVisibilityResults: { interstitial: {} } }),
    false,
  );
  wrapped.tweet.core.user_results.result.legacy.protected = true;
  assert.equal(rawIsPublic(wrapped), false);
  assert.equal(rawIsPublic({ ...raw, limitedActionResults: {} }), false);
  delete raw.core.user_results.result.legacy.protected;
  assert.equal(rawIsPublic(raw), false);
  result = await parseSessionResult("900123", structuredClone(raw), host);
  assert.equal(result.visibility, Visibility.VISIBILITY_PRIVATE);
});

test("summary counts each media item in order, excluding author avatars", () => {
  const post = structuredClone(fixture.status);
  post.media.all = [
    { type: "photo", url: "https://media.test/1.jpg" },
    { type: "photo", url: "https://media.test/2.jpg" },
    { type: "video", url: "https://media.test/3.mp4" },
    { type: "gif", url: "https://media.test/4.mp4" },
  ];
  const result = normalize(
    post,
    post.id,
    "fxtwitter",
    Visibility.VISIBILITY_PUBLIC,
  );
  assert.equal(
    result.summary,
    `${post.author.name}：${post.text}[图片][图片][视频][视频]`,
  );
  assert.equal(result.authorName, post.author.name);
  assert.equal(result.publishedAt, "2026-01-01T00:00:00.000Z");
});
