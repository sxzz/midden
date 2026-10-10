import { status } from "@grpc/grpc-js";
import { instagramShortcodeToPk } from "@fxembed/atmosphere/providers/instagram/shortcode";
import { ResolveResponse } from "./generated/api/adapter/v1/adapter.js";
import { ProviderError } from "./errors.js";

export const hosts = ["instagram.com", "www.instagram.com", "m.instagram.com"];
export const handlePattern =
  /^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$/;
const reserved = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "about",
  "developer",
  "developers",
  "legal",
  "web",
  "api",
  "graphql",
  "challenge",
  "privacy",
  "terms",
  "download",
  "nametag",
]);

export function resolveTarget(raw: string): ResolveResponse {
  try {
    const url = new URL(raw.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.includes(url.hostname)
    )
      throw new Error();
    const match = url.pathname.match(
      /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]{1,20})\/?$/,
    );
    if (match)
      return ResolveResponse.fromPartial({
        url: `https://www.instagram.com/p/${match[1]}/`,
        platform: "instagram",
        kind: "post",
        externalId: String(instagramShortcodeToPk(match[1]!)),
      });
    const handle = url.pathname.match(/^\/([^/]+)\/?$/)?.[1]?.toLowerCase();
    if (
      handle &&
      handlePattern.test(handle) &&
      !handle.includes("..") &&
      !reserved.has(handle)
    )
      return ResolveResponse.fromPartial({
        url: `https://www.instagram.com/${handle}/`,
        platform: "instagram",
        kind: "profile",
        externalId: `handle:${handle}`,
        refreshOnSubmit: true,
        collection: true,
      });
    throw new Error();
  } catch {
    throw new ProviderError(
      status.INVALID_ARGUMENT,
      "unsupported Instagram URL",
    );
  }
}

export function shortcodeFromPk(id: string): string {
  let value = BigInt(id),
    result = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  do {
    result = chars[Number(value % 64n)] + result;
    value /= 64n;
  } while (value);
  return result;
}
