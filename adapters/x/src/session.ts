import { accountBootstrap, accountUserAgent } from "./bootstrap.js";
import { status } from "@grpc/grpc-js";
import { fetchByRestId } from "@fxembed/atmosphere/providers/twitter/conversation";
import { buildAPITwitterStatus } from "@fxembed/atmosphere/providers/twitter/processor";
import { needsTransactionId } from "@fxembed/atmosphere/providers/twitter/proxy/allowlist";
import { ClientTransaction } from "@fxembed/atmosphere/providers/twitter/proxy/transaction/transaction";
import {
  getTwitterProviderEnv,
  setTwitterProviderEnv,
} from "@fxembed/atmosphere/providers/twitter-runtime";
import type { TwitterBuildHost } from "@fxembed/atmosphere/providers/twitter/build-host";
import {
  SessionCredential,
  SourceResponse,
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
  responses?: SourceResponse[],
): TwitterBuildHost["twitterProxy"] {
  validateCredential(credential);
  let transaction: Promise<ClientTransaction> | undefined;
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
      headers.set("user-agent", accountUserAgent);
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
      headers.delete("x-client-transaction-id");
      if (needsTransactionId(url.toString())) {
        transaction ??= accountBootstrap(credential, signal, fetcher).then(
          ({ html }) => ClientTransaction.fromHTML(html),
        );
        let generator: ClientTransaction;
        try {
          generator = await transaction;
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          throw new ProviderError(
            status.UNAVAILABLE,
            "account request signing unavailable",
          );
        }
        headers.set(
          "x-client-transaction-id",
          await generator.generateTransactionId(
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
      if (response.headers.get("cf-mitigated") === "challenge") {
        await response.body?.cancel();
        throw new ProviderError(
          status.UNAVAILABLE,
          "X requires browser verification; account validity is unknown",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw responseError(
          response.status,
          response.headers.get("retry-after"),
        );
      }
      const data = await readJSON(response, (body) => {
        if (responses) {
          if (
            responses.reduce((n, r) => n + r.body.length, 0) + body.length >
            4 << 20
          )
            throw new ProviderError(
              status.RESOURCE_EXHAUSTED,
              "source responses exceed limit",
            );
          responses.push({
            body: Buffer.from(body),
            contentType:
              response.headers.get("content-type") ?? "application/json",
            sourceUrl: url.toString(),
            visibility: Visibility.VISIBILITY_PRIVATE,
          });
        }
      });
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
  // A sensitive-media blur changes presentation, not who may read the post.
  // Unknown wrapper/visibility fields still require private storage.
  if (node.__typename === "TweetWithVisibilityResults") {
    if (
      Object.keys(node).some(
        (key) =>
          !["__typename", "tweet", "mediaVisibilityResults"].includes(key),
      )
    )
      return false;
    const media = node.mediaVisibilityResults;
    if (
      media != null &&
      (typeof media !== "object" ||
        Array.isArray(media) ||
        Object.keys(media).some((key) => key !== "blurred_image_interstitial"))
    )
      return false;
    return rawIsPublic(node.tweet);
  }
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
  const responses: SourceResponse[] = [];
  const host: TwitterBuildHost = {
    t: (key) => key,
    twitterProxy: accountTransport(credential, signal, fetch, responses),
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
  const result = await parseSessionResult(id, raw, host);
  result.sourceResponses = responses;
  return result;
}
export async function parseSessionResult(
  id: string,
  raw: any,
  host: TwitterBuildHost,
) {
  const publicEvidence = rawIsPublic(raw);
  const editSource = structuredClone(raw);
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
  const result = normalize(
    post,
    id,
    "x-session",
    publicEvidence ? visibilityOf(post) : Visibility.VISIBILITY_PRIVATE,
    editSource,
  );
  if (raw?.mediaVisibilityResults?.blurred_image_interstitial) {
    for (const resource of result.resources) resource.sensitive = true;
  }
  return result;
}
export async function checkSession(
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  validateCredential(credential);
  // Viewer identifies the authenticated session itself, not a caller-supplied
  // user ID or the author of a publicly readable post.
  const url = new URL(
    "https://api.x.com/graphql/9t128XgFic52jPUEkJMf6w/Viewer",
  );
  url.searchParams.set(
    "variables",
    JSON.stringify({
      withCommunitiesMemberships: true,
      withSubscribedTab: true,
      withCommunitiesCreation: true,
    }),
  );
  url.searchParams.set(
    "features",
    JSON.stringify({
      subscriptions_upsells_api_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: true,
      rweb_tipjar_consumption_enabled: false,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }),
  );
  const transport = accountTransport(credential, signal, fetcher)!;
  const response = await transport.fetch(url);
  const data = await readJSON(response);
  const viewer = data?.data?.viewer;
  if (viewer?.is_tfe_restricted_session === true)
    throw new ProviderError(
      status.PERMISSION_DENIED,
      "account session is restricted",
    );
  const user = viewer?.user_results?.result;
  const accountId = user?.rest_id;
  const username = user?.core?.screen_name;
  if (
    user?.__typename !== "User" ||
    typeof accountId !== "string" ||
    !/^[0-9]+$/.test(accountId) ||
    typeof username !== "string" ||
    !/^[A-Za-z0-9_]{1,50}$/.test(username)
  )
    throw new ProviderError(
      status.FAILED_PRECONDITION,
      "account verification response format changed",
    );
  return { accountId, username };
}
