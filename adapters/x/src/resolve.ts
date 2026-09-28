import { status } from "@grpc/grpc-js";
import { ProviderError } from "./provider.js";
export function resolveTarget(raw: string) {
  try {
    const url = new URL(raw.trim());
    const match = url.pathname.match(
      /^\/(?:[A-Za-z0-9_]{1,20}|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(url.hostname)
    )
      throw new Error();
    if (match)
      return {
        url: `https://x.com/${url.pathname.split("/")[1] === "i" ? "i/web" : url.pathname.split("/")[1]}/status/${match[1]}`,
        platform: "x",
        kind: "post",
        objectScope: "",
        externalId: match[1],
        refreshOnSubmit: false,
      };
    const id = url.pathname.match(/^\/i\/user\/(\d+)\/?$/);
    const handle = url.pathname
      .match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]
      .toLowerCase();
    const reserved = new Set([
      "home",
      "explore",
      "search",
      "settings",
      "messages",
      "notifications",
      "compose",
      "intent",
      "share",
      "i",
      "login",
      "logout",
      "signup",
      "tos",
      "privacy",
      "about",
      "jobs",
      "download",
    ]);
    if (id || (handle && !reserved.has(handle)))
      return {
        url: id ? `https://x.com/i/user/${id[1]}` : `https://x.com/${handle}`,
        platform: "x",
        kind: "profile",
        objectScope: "",
        externalId: id ? id[1] : `handle:${handle}`,
        refreshOnSubmit: true,
      };
    throw new Error();
  } catch {
    throw new ProviderError(status.INVALID_ARGUMENT, "unsupported X URL");
  }
}
