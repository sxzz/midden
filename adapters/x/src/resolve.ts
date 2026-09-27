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
      !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(url.hostname) ||
      !match
    )
      throw new Error();
    return {
      url: `https://x.com/i/web/status/${match[1]}`,
      platform: "x",
      kind: "post",
      objectScope: "",
      externalId: match[1],
    };
  } catch {
    throw new ProviderError(status.INVALID_ARGUMENT, "unsupported post URL");
  }
}
