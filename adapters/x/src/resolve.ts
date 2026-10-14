import { status } from "@grpc/grpc-js";
import { ProviderError } from "./provider.js";
// FxEmbed mirrors X paths on its own domains. A subdomain only picks how the
// embed is rendered (direct media, gallery, text), never another object.
const mirrors = ["fxtwitter.com", "fixupx.com"];
const mirrorModes = ["www", "d", "dl", "g", "t"];
export const hosts = [
  ...["x.com", "twitter.com"].flatMap((host) => [
    host,
    `www.${host}`,
    `mobile.${host}`,
  ]),
  ...mirrors.flatMap((host) => [
    host,
    ...mirrorModes.map((mode) => `${mode}.${host}`),
  ]),
];
export function resolveTarget(raw: string) {
  try {
    const url = new URL(raw.trim());
    const mirror = mirrors.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    // A mirrored post link may end with the language to translate it into.
    if (mirror)
      url.pathname = url.pathname.replace(
        /(\/status\/\d+(?:\/(?:photo|video)\/\d+)?)\/[A-Za-z]{2}(?:-[A-Za-z]{2,4})?\/?$/,
        "$1",
      );
    const match = url.pathname.match(
      /^\/(?:[A-Za-z0-9_]{1,20}|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.includes(url.hostname)
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
        collection: false,
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
        collection: true,
      };
    throw new Error();
  } catch {
    throw new ProviderError(status.INVALID_ARGUMENT, "unsupported X URL");
  }
}
