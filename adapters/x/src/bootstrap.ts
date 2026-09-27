import { status } from "@grpc/grpc-js";
import { ProviderError, responseError } from "./provider.js";
import type { SessionCredential } from "./generated/api/adapter/v1/adapter.js";

export const accountUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Parse JSON only; never evaluate JavaScript returned by the platform.
export function bootstrapIdentity(html: string) {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  const invalid = () =>
    new ProviderError(
      status.FAILED_PRECONDITION,
      "account verification page format changed",
    );
  if (!marker) throw invalid();
  const input = html.slice(marker.index + marker[0].length);
  if (input[0] !== "{") throw invalid();
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      let state: any;
      try {
        state = JSON.parse(input.slice(0, i + 1));
      } catch {
        throw invalid();
      }
      const id = state.session?.user_id;
      const user = state.entities?.users?.entities?.[id];
      if (state.session?.isRestrictedSession === true)
        throw new ProviderError(
          status.PERMISSION_DENIED,
          "account session is restricted",
        );
      if (
        state.session?.isLoaded !== true ||
        typeof id !== "string" ||
        !/^\d+$/.test(id) ||
        typeof user?.screen_name !== "string" ||
        !/^[A-Za-z0-9_]{1,50}$/.test(user.screen_name)
      )
        throw invalid();
      return { accountId: id, username: user.screen_name };
    }
  }
  throw invalid();
}

export async function accountBootstrap(
  credential: SessionCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher("https://x.com/home", {
    headers: {
      cookie: `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      "user-agent": accountUserAgent,
    },
    signal,
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(
      response.headers.get("location") ?? "/",
      "https://x.com",
    );
    if (
      location.hostname === "x.com" &&
      /\/(?:login|i\/flow\/login|i\/jf\/onboarding\/web)/.test(
        location.pathname,
      )
    ) {
      throw new ProviderError(
        status.UNAUTHENTICATED,
        "account session expired; authorize again",
      );
    }
    throw new ProviderError(
      status.UNAVAILABLE,
      "unexpected account verification redirect",
    );
  }
  if (response.headers.get("cf-mitigated") === "challenge") {
    await response.body?.cancel();
    throw new ProviderError(
      status.UNAVAILABLE,
      "X requires browser verification; account validity is unknown",
    );
  }
  if (!response.ok)
    throw responseError(response.status, response.headers.get("retry-after"));
  const reader = response.body?.getReader();
  if (!reader)
    throw new ProviderError(
      status.UNAVAILABLE,
      "empty account verification response",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 << 20)
        throw new ProviderError(
          status.UNAVAILABLE,
          "account verification response too large",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const html = Buffer.concat(chunks).toString("utf8");
  return { html, identity: bootstrapIdentity(html) };
}
