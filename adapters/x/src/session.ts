import { status } from "@grpc/grpc-js";
import { fetchByRestId } from "@fxembed/atmosphere/providers/twitter/conversation";
import { buildAPITwitterStatus } from "@fxembed/atmosphere/providers/twitter/processor";
import { ClientTransaction } from "@fxembed/atmosphere/providers/twitter/proxy/transaction/transaction";
import {
  getTwitterProviderEnv,
  setTwitterProviderEnv,
} from "@fxembed/atmosphere/providers/twitter-runtime";
import type { TwitterBuildHost } from "@fxembed/atmosphere/providers/twitter/build-host";
import {
  SessionCredential,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";
import {
  normalize,
  ProviderError,
  readJSON,
  responseError,
} from "./provider.js";

// Public application token from pinned upstream src/constants.ts; not an account secret.
setTwitterProviderEnv({
  guestBearerToken:
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
  friendlyUserAgent: "Monitor/0.4",
});

export function validateCredential(
  c?: SessionCredential,
): asserts c is SessionCredential {
  if (
    !c ||
    !/^[A-Za-z0-9_-]{10,4096}$/.test(c.authToken) ||
    !/^[A-Za-z0-9_-]{10,4096}$/.test(c.csrfToken)
  )
    throw new ProviderError(status.INVALID_ARGUMENT, "invalid account session");
}
export function accountTransport(
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): TwitterBuildHost["twitterProxy"] {
  validateCredential(credential);
  return {
    fetch: async (input, init = {}) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (
        !["api.x.com", "api.twitter.com", "x.com", "twitter.com"].includes(
          url.hostname,
        )
      )
        throw new ProviderError(
          status.FAILED_PRECONDITION,
          "unsupported account endpoint",
        );
      const headers = new Headers(init.headers);
      headers.set(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      );
      headers.set("referer", "https://x.com/");
      headers.set("origin", "https://x.com");
      headers.set("accept", "application/json");
      headers.set("authorization", getTwitterProviderEnv().guestBearerToken);
      headers.set(
        "cookie",
        `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      );
      headers.set("x-csrf-token", credential.csrfToken);
      headers.set("x-twitter-auth-type", "OAuth2Session");
      headers.set("x-twitter-active-user", "yes");
      headers.delete("x-guest-token");
      if (url.pathname.includes("/graphql/")) {
        const transaction = await ClientTransaction.create();
        headers.set(
          "x-client-transaction-id",
          await transaction.generateTransactionId(
            init.method ?? "GET",
            url.pathname,
          ),
        );
      }
      const response = await fetcher(url, {
        ...init,
        headers,
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw responseError(
          response.status,
          response.headers.get("retry-after"),
        );
      const data = await readJSON(response);
      if (Array.isArray(data.errors) && data.errors.length) {
        const codes = data.errors.map((e: any) => e.code);
        if (codes.some((c: number) => [32, 89, 135, 215, 326].includes(c)))
          throw responseError(401);
        if (codes.includes(88))
          throw responseError(429, response.headers.get("retry-after"));
        if (codes.some((c: number) => [63, 179, 200].includes(c)))
          throw responseError(403);
        throw new ProviderError(
          status.UNAVAILABLE,
          "account provider returned an error",
        );
      }
      return Response.json(data);
    },
  };
}
// Public classification requires positive evidence for every included author.
export function visibilityOf(post: any): Visibility {
  if (post?.type !== "status" || post.author?.protected !== false)
    return Visibility.VISIBILITY_PRIVATE;
  for (const key of ["quote", "repost"])
    if (post[key] && visibilityOf(post[key]) !== Visibility.VISIBILITY_PUBLIC)
      return Visibility.VISIBILITY_PRIVATE;
  return Visibility.VISIBILITY_PUBLIC;
}
// Atmosphere defaults a missing protected flag to false; inspect raw evidence first.
export function rawIsPublic(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  // Visibility wrappers can carry audience restrictions outside the tweet itself.
  if (node.__typename === "TweetWithVisibilityResults") return false;
  const root = node.tweet ?? node.result ?? node;
  const author =
    root.core?.user_results?.result ?? root.core?.user_result?.result;
  const protectedFlag = author?.privacy?.protected ?? author?.legacy?.protected;
  if (protectedFlag !== false) return false;
  let restricted = false;
  const walk = (value: any): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        child &&
        /trusted_friends|exclusive_tweet|limited_?actions?|tombstone|interstitial|audience|community_results/i.test(
          key,
        )
      )
        restricted = true;
      if (key === "protected" && child !== false) restricted = true;
      if (
        /^quoted_(status_result|tweet_results)$/.test(key) &&
        !rawIsPublic(child)
      )
        restricted = true;
      if (/^retweeted_status_results?$/.test(key) && !rawIsPublic(child))
        restricted = true;
      if (typeof child === "object") walk(child);
    }
  };
  walk(node);
  return !restricted;
}
export async function fetchSession(
  id: string,
  credential: SessionCredential,
  signal: AbortSignal,
) {
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal),
    shouldTranscodeGif: () => false,
  };
  const data = await fetchByRestId(id, host, true);
  const raw = data?.data?.tweetResult?.result;
  if (
    !raw ||
    raw.__typename === "TweetUnavailable" ||
    raw.__typename === "TweetTombstone"
  )
    throw responseError(403);
  return parseSessionResult(id, raw, host);
}
export async function parseSessionResult(
  id: string,
  raw: any,
  host: TwitterBuildHost,
) {
  const publicEvidence = rawIsPublic(raw);
  const post = await buildAPITwitterStatus(
    host,
    raw,
    undefined,
    null,
    false,
    false,
    "root",
    id,
  );
  return normalize(
    post,
    id,
    "x-session",
    publicEvidence ? visibilityOf(post) : Visibility.VISIBILITY_PRIVATE,
  );
}
export async function checkSession(
  credential: SessionCredential,
  signal: AbortSignal,
) {
  const transport = accountTransport(credential, signal)!;
  const response = await transport.fetch(
    "https://api.x.com/1.1/account/verify_credentials.json?skip_status=true&include_entities=false",
  );
  const user = (await response.json()) as {
    id_str?: string;
    screen_name?: string;
  };
  if (!user.id_str || !user.screen_name)
    throw new ProviderError(
      status.UNAVAILABLE,
      "invalid account verification response",
    );
  return { accountId: user.id_str, username: user.screen_name };
}
