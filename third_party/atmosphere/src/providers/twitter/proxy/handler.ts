import { filterObject } from "./filter.js";
import { ClientTransaction } from "./transaction/transaction.js";
import { getTwitterProxyRuntime } from "../../twitter-runtime.js";
import { mergeCookies } from "./cookies.js";
import { needsTransactionId } from "./allowlist.js";
import {
  classifyAPIErrors,
  isSearchTimelineClientErrorResponse,
  jsonError,
  jsonHasTruthyErrorsProperty,
  twitterResponseLooksEmpty,
} from "./errors.js";
import { sendDiscordAlert } from "./discord.js";
import type { ProxyEnv } from "../../../types/proxy-credentials.js";

const redactUsername = false;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Proxies an incoming request to api.x.com using session credentials, applying cookies, optional CSRF and x-client-transaction-id headers, and retrying with different accounts when upstream errors occur.
 *
 * May send a Discord alert if configured, strip leaked usernames from responses, and return a synthetic error response after repeated failures.
 *
 * @param request - The original incoming Request to forward
 * @param env - Environment/configuration values used by the proxy (for example webhook and feature flags)
 * @returns The response returned to the caller reflecting the proxied api.x.com response (status, headers, and possibly transformed body) or an error response when retries are exhausted
 */
export async function proxyTwitterRequest(
  request: Request,
  env: ProxyEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const apiUrl = `https://api.x.com${url.pathname}${url.search}`;
  const requestPath = url.pathname.split("?")[0];

  const headers = new Headers(request.headers);
  headers.delete("x-guest-token");

  let existingCookies = request.headers.get("Cookie");

  const newRequestInit: RequestInit = {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    integrity: request.integrity,
    signal: request.signal,
  };

  const textDecoder = new TextDecoder("utf-8");

  let response!: Response;
  let json: unknown;
  let errors: boolean;
  let decodedBody!: string;
  let attempts = 0;

  do {
    errors = false;
    const { authToken, csrfToken, username } =
      getTwitterProxyRuntime().getRandomTwitterAccount();
    const graphql = apiUrl.includes("graphql");
    const authValid =
      typeof authToken === "string" && authToken.trim().length > 0;
    const csrfValid =
      !graphql ||
      (typeof csrfToken === "string" && csrfToken.trim().length > 0);

    if (!authValid || !csrfValid) {
      void 0;
      errors = true;
    } else {
      let newCookies = `auth_token=${authToken}`;
      if (graphql) {
        existingCookies = existingCookies?.replace(/ct0=(.+?);/, "") || "";
        newCookies = `auth_token=${authToken}; ct0=${csrfToken}; `;
        headers.set("x-csrf-token", csrfToken);
      }
      const cookies = mergeCookies(existingCookies?.toString(), newCookies);

      headers.set("Cookie", cookies);
      headers.delete("Accept-Encoding");

      headers.delete("x-client-transaction-id");
      if (needsTransactionId(apiUrl)) {
        try {
          const transaction = await ClientTransaction.create(attempts > 1);
          const transactionId = await transaction.generateTransactionId(
            request.method,
            requestPath,
          );
          void 0;
          headers.set("x-client-transaction-id", transactionId);
        } catch (e) {
          headers.delete("x-client-transaction-id");
          void 0;
        }
      }

      newRequestInit.headers = headers;

      const newRequest = new Request(apiUrl, newRequestInit);
      const startTime = performance.now();
      response = await fetch(newRequest);
      const endTime = performance.now();
      void 0;

      const rawBody = textDecoder.decode(await response.arrayBuffer());
      decodedBody = rawBody.match(/\{[\s\S]+\}/gm)?.[0] || "{}";

      const rateLimitRemaining =
        response.headers.get("x-rate-limit-remaining") ?? "N/A";
      void 0;
      const rateLimitReset = response.headers.get("x-rate-limit-reset") ?? "0";
      const rateLimitResetDate = new Date(Number(rateLimitReset) * 1000);
      void 0;

      try {
        void 0;
        void 0;
        json = JSON.parse(decodedBody) as unknown;

        if (
          jsonHasTruthyErrorsProperty(json) ||
          decodedBody.includes('"reason":"NsfwViewerIsUnderage"')
        ) {
          const outcome = classifyAPIErrors(json, decodedBody, response.status);
          if (outcome.action === "respond") {
            return outcome.response;
          }
          if (outcome.action === "ignore") {
            errors = false;
          } else {
            errors = true;
          }
        }

        let variablesDisplay = url.searchParams.get("variables") ?? "";
        try {
          if (variablesDisplay) {
            variablesDisplay = JSON.stringify(
              JSON.parse(variablesDisplay),
              null,
              2,
            );
          }
        } catch {
          variablesDisplay = url.search;
        }
        if (!variablesDisplay) {
          variablesDisplay = url.search;
        }

        if (env.EXCEPTION_DISCORD_WEBHOOK && errors) {
          try {
            await sendDiscordAlert(
              env,
              username,
              requestPath,
              asRecord(json)?.["errors"],
              variablesDisplay,
            );
          } catch (alertErr) {
            void 0;
          }
        }

        if (
          twitterResponseLooksEmpty(json) &&
          !isSearchTimelineClientErrorResponse(json)
        ) {
          void 0;
          errors = true;
        }

        if (rawBody.includes(username)) {
          void 0;
          decodedBody = JSON.stringify(filterObject(json, username));
        }
      } catch (e) {
        void 0;
        errors = true;
      }

      if (
        apiUrl.includes("translation.json") ||
        apiUrl.includes("live_video_stream")
      ) {
        decodedBody = rawBody;
      }
    }

    if (errors) {
      void 0;
      attempts++;
      if (attempts > 4) {
        void 0;
        return jsonError("Maximum failed attempts reached", 502);
      }
    }
  } while (errors);

  const decodedResponse = new Response(decodedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  void 0;

  return decodedResponse;
}
