import { Metadata, status } from "@grpc/grpc-js";

export class ProviderError extends Error {
  metadata = new Metadata();
  constructor(
    public code: status,
    message: string,
    retry?: string | null,
  ) {
    super(message);
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry)
        : retry
          ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
          : 0;
    if (seconds > 0)
      this.metadata.set("retry-after", String(Math.min(seconds, 86400)));
  }
}

export function credentialRequired(): never {
  const error = new ProviderError(
    status.FAILED_PRECONDITION,
    "Instagram requires an account; select an Instagram account and retry",
  );
  error.metadata.set("credential-required", "1");
  throw error;
}

export function responseError(
  code: number,
  account: boolean,
  retry?: string | null,
): ProviderError {
  if (code === 429)
    return new ProviderError(
      status.RESOURCE_EXHAUSTED,
      "Instagram rate limited the request",
      retry,
    );
  if (code >= 500)
    return new ProviderError(
      status.UNAVAILABLE,
      "Instagram temporarily unavailable",
      retry,
    );
  if (code === 401)
    return new ProviderError(
      account ? status.UNAUTHENTICATED : status.FAILED_PRECONDITION,
      account
        ? "Instagram session expired; authorize again"
        : "Instagram requires login",
    );
  if (code === 403)
    return new ProviderError(
      account ? status.PERMISSION_DENIED : status.FAILED_PRECONDITION,
      "Instagram access denied or browser verification required",
    );
  if (code === 404)
    return new ProviderError(
      status.NOT_FOUND,
      "Instagram content not found or inaccessible",
    );
  return new ProviderError(
    status.UNAVAILABLE,
    "Instagram returned an invalid response",
  );
}
