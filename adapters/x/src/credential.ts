import { status } from "@grpc/grpc-js";
import { ProviderError } from "./provider.js";
import type { Credential } from "./generated/api/adapter/v1/adapter.js";

export interface SessionCredential {
  authToken: string;
  csrfToken: string;
}
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
export function decodeCredential(c?: Credential): SessionCredential {
  try {
    const raw = JSON.parse(Buffer.from(c?.data ?? []).toString("utf8"));
    const value = { authToken: raw.auth_token, csrfToken: raw.csrf_token };
    validateCredential(value);
    return value;
  } catch {
    throw new ProviderError(status.INVALID_ARGUMENT, "invalid account session");
  }
}
export function prepareCredential(input: Uint8Array): Credential {
  try {
    if (!input.length || input.length > 16384) throw new Error();
    const text = Buffer.from(input).toString("utf8").trim();
    let c: SessionCredential;
    if (text.startsWith("{")) {
      c = decodeCredential({ data: Buffer.from(text) });
    } else {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error();
      const decoded = Buffer.from(text, "base64");
      if (
        decoded.toString("base64").replace(/=+$/, "") !==
        text.replace(/=+$/, "")
      )
        throw new Error();
      const cookie = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      if (/[\r\n\x00]/.test(cookie)) throw new Error();
      const values = new Map<string, string>();
      for (const part of cookie.split(";")) {
        if (!part.trim()) continue;
        const index = part.indexOf("=");
        if (index < 0) throw new Error();
        const key = part.slice(0, index).trim(),
          value = part.slice(index + 1).trim();
        if (key !== "auth_token" && key !== "ct0") continue;
        if (values.has(key)) throw new Error();
        values.set(key, value);
      }
      c = {
        authToken: values.get("auth_token") ?? "",
        csrfToken: values.get("ct0") ?? "",
      };
      validateCredential(c);
    }
    return {
      data: Buffer.from(
        JSON.stringify({ auth_token: c.authToken, csrf_token: c.csrfToken }),
      ),
    };
  } catch {
    throw new ProviderError(
      status.INVALID_ARGUMENT,
      "invalid account credential input",
    );
  }
}
