import { status } from "@grpc/grpc-js";
import type { InstagramCredentials } from "@fxembed/atmosphere/types/proxy-credentials";
import type { Credential } from "./generated/api/adapter/v1/adapter.js";
import { ProviderError } from "./errors.js";

export type SessionCredential = Pick<
  InstagramCredentials,
  "sessionId" | "csrfToken" | "userId" | "mid" | "deviceId"
>;
const fields = {
  sessionid: "sessionId",
  csrftoken: "csrfToken",
  ds_user_id: "userId",
  mid: "mid",
  ig_did: "deviceId",
} as const;

function validate(value: SessionCredential): SessionCredential {
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    Object.values(value).some(
      (v) =>
        typeof v !== "string" ||
        !v ||
        v.length > 4096 ||
        /[\s;\x00-\x1f\x7f]/.test(v),
    ) ||
    (value.userId && !/^\d+$/.test(value.userId))
  )
    throw new Error("invalid session");
  return value;
}

export function decodeCredential(credential?: Credential): SessionCredential {
  try {
    const raw = JSON.parse(
      Buffer.from(credential?.data ?? []).toString("utf8"),
    );
    const value: SessionCredential = { sessionId: raw.sessionId };
    for (const key of Object.values(fields))
      if (raw[key] !== undefined) value[key] = raw[key];
    return validate(value);
  } catch {
    throw new ProviderError(
      status.INVALID_ARGUMENT,
      "invalid Instagram session",
    );
  }
}

export function prepareCredential(input: Uint8Array): Credential {
  try {
    const encoded = Buffer.from(input).toString("utf8").trim();
    if (
      !input.length ||
      input.length > 16384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new Error();
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
    )
      throw new Error();
    const cookie = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    if (/[\r\n\x00]/.test(cookie)) throw new Error();
    const value = {} as SessionCredential;
    const seen = new Set<string>();
    for (const part of cookie.split(";")) {
      if (!part.trim()) continue;
      const index = part.indexOf("=");
      if (index < 1) throw new Error();
      const name = part.slice(0, index).trim();
      if (!(name in fields)) continue;
      if (seen.has(name)) throw new Error();
      seen.add(name);
      value[fields[name as keyof typeof fields]] = part.slice(index + 1).trim();
    }
    return { data: Buffer.from(JSON.stringify(validate(value))) };
  } catch {
    throw new ProviderError(
      status.INVALID_ARGUMENT,
      "invalid Instagram Cookie; provide a Base64 browser Cookie containing sessionid",
    );
  }
}
