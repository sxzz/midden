import { avatarImmutableKey } from "./entities.js";
import type { FetchResponse } from "./generated/api/adapter/v1/adapter.js";

// Probe only X's image CDN. Keep the upstream metadata and raw response intact.
// An avatar path names one particular image, so an original found once stays.
const maxKnownOriginals = 5000;
const knownOriginals = new Map<string, string>();

export async function preferOriginalAvatars(
  result: FetchResponse,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  known = knownOriginals,
): Promise<void> {
  const resolved = new Map<string, string>();
  for (const resource of result.resources) {
    if (resource.purpose !== "avatar" || !avatarImmutableKey(resource.url))
      continue;
    const original = resource.url;
    const candidate = new URL(original);
    if (!/_normal\.[^/.]+$/.test(candidate.pathname)) continue;
    candidate.pathname = candidate.pathname.replace(/_normal(\.[^/.]+)$/, "$1");
    if (known.has(original)) resolved.set(original, known.get(original)!);
    if (!resolved.has(original)) {
      let selected = original;
      try {
        const response = await fetcher(candidate.href, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
          headers: { Accept: "image/*", Range: "bytes=0-0" },
        });
        try {
          if (
            response.ok &&
            response.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("image/")
          ) {
            selected = candidate.href;
            known.set(original, selected);
            while (known.size > maxKnownOriginals)
              known.delete(known.keys().next().value!);
          }
        } finally {
          await response.body?.cancel();
        }
      } catch {}
      resolved.set(original, selected);
    }
    resource.url = resolved.get(original)!;
    resource.immutableKey = avatarImmutableKey(resource.url);
  }
}
