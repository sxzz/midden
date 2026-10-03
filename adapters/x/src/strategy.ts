import { attachMentions } from "./entities.js";
import { preferOriginalAvatars } from "./avatar.js";
import { status } from "@grpc/grpc-js";
import {
  fetchPublic,
  ProviderError,
  publicPost,
  sourceState,
} from "./provider.js";
import { fetchSession } from "./session.js";
import {
  fetchPublicProfile,
  fetchPublicTimeline,
  fetchSessionTimeline,
} from "./profile.js";
import type { SessionCredential } from "./credential.js";
import {
  FetchResponse,
  Visibility,
  type FetchRequest,
} from "./generated/api/adapter/v1/adapter.js";

const profileTTL = 60_000;
const maxCachedProfiles = 1000;
// A public timeline lists its posts in full. They are kept long enough for the
// core to come back for each one, so a listed post costs no request of its own.
const listedPostTTL = 30 * 60_000;
const maxListedPosts = 2000;
export class CaptureStrategy {
  private profiles = new Map<string, { at: number; value: FetchResponse }>();
  private listed = new Map<
    string,
    { at: number; post: any; sourceUrl: string }
  >();
  private pending = new Map<string, Promise<FetchResponse>>();
  constructor(
    private publicPost = fetchPublic,
    private publicProfile = fetchPublicProfile,
    private sessionPost = fetchSession,
    private sessionTimeline = fetchSessionTimeline,
    private now = Date.now,
  ) {}

  private remember(value: FetchResponse) {
    const user = this.user(value);
    for (const key of [
      value.canonicalTarget!.externalId,
      `handle:${user.screen_name.toLowerCase()}`,
    ]) {
      this.profiles.delete(key);
      this.profiles.set(key, {
        at: this.now(),
        value: FetchResponse.fromPartial(value),
      });
    }
    while (this.profiles.size > maxCachedProfiles)
      this.profiles.delete(this.profiles.keys().next().value!);
  }
  private user(profile: FetchResponse): any {
    return JSON.parse(
      Buffer.from(
        profile.graph!.entities.find((e) => e.key === profile.graph!.root)!
          .dataJson,
      ).toString(),
    ).metadata;
  }
  private async profile(
    id: string,
    force: boolean,
    signal: AbortSignal,
  ): Promise<FetchResponse> {
    const cached = this.profiles.get(id);
    if (!force && cached && this.now() - cached.at < profileTTL)
      return FetchResponse.fromPartial(cached.value);
    const key = `${force ? "explicit" : "automatic"}:${id}`;
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.publicProfile(id, false, signal)
        .catch((error) => {
          if (
            error instanceof ProviderError &&
            error.code === status.UNAUTHENTICATED
          )
            throw new ProviderError(
              status.UNAVAILABLE,
              "public profile service unavailable",
            );
          throw error;
        })
        .then((value) => {
          this.remember(value);
          return value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    return FetchResponse.fromPartial(await promise);
  }
  private list(post: any, sourceUrl: string) {
    // The listing carries only a stub of an article; the post's own response
    // has its content.
    if (
      post?.type !== "status" ||
      typeof post.id !== "string" ||
      !/^\d+$/.test(post.id) ||
      post.article
    )
      return;
    this.listed.delete(post.id);
    // A post's own response never says who reposted it into a timeline.
    this.listed.set(post.id, {
      at: this.now(),
      post: { ...post, reposted_by: null },
      sourceUrl,
    });
    while (this.listed.size > maxListedPosts)
      this.listed.delete(this.listed.keys().next().value!);
  }
  // Only automatic captures settle for the listing; an explicit one asks upstream.
  private async post(
    req: FetchRequest,
    signal: AbortSignal,
  ): Promise<FetchResponse> {
    const listed = req.automatic && this.listed.get(req.externalId);
    if (listed && this.now() - listed.at < listedPostTTL)
      try {
        return publicPost(listed.post, req.externalId, {
          body: Buffer.from(JSON.stringify(listed.post)),
          contentType: "application/json",
          sourceUrl: listed.sourceUrl,
          visibility: Visibility.VISIBILITY_PUBLIC,
        });
      } catch {
        // Whatever the listing lacks, the post's own response decides.
      }
    return this.publicPost(req.externalId, signal);
  }
  private protected(profile: FetchResponse): boolean {
    const value = this.user(profile).protected;
    if (typeof value !== "boolean")
      throw new ProviderError(
        status.UNAVAILABLE,
        "profile protection status unavailable",
      );
    return value;
  }
  async fetch(
    req: FetchRequest,
    signal: AbortSignal,
    credential?: SessionCredential,
  ): Promise<FetchResponse> {
    let result: FetchResponse;
    if (req.pageCursor && (req.kind !== "profile" || req.automatic))
      throw new ProviderError(
        status.INVALID_ARGUMENT,
        "invalid collection continuation",
      );
    if (req.kind === "profile") {
      result = await this.profile(req.externalId, !req.automatic, signal);
      result.externalId = req.externalId;
      if (!req.automatic) {
        const mode = this.protected(result) ? "private" : "public";
        result.maxBatchSize = mode === "public" ? 1000 : 0;
        let cursor = "";
        if (req.pageCursor) {
          try {
            const page = JSON.parse(req.pageCursor);
            if (
              page.user !== result.canonicalTarget!.externalId ||
              page.mode !== mode ||
              typeof page.cursor !== "string" ||
              !page.cursor ||
              req.pageCursor.length > 4096
            )
              throw new Error();
            cursor = page.cursor;
          } catch {
            throw new ProviderError(
              status.FAILED_PRECONDITION,
              "collection changed; start again from the profile link",
            );
          }
        }
        if (this.protected(result)) {
          if (credential) {
            // The collection of protected posts is account-private, while the profile metadata is public.
            result.visibility = Visibility.VISIBILITY_PRIVATE;
            await this.sessionTimeline(
              result,
              credential,
              signal,
              undefined,
              cursor,
              req.pageSize,
            );
          } else {
            result.incomplete = true;
            result.warnings.push("帖子受保护，需添加有访问权限的采集账号。");
          }
        } else {
          // Fetch only the timeline here; reuse the profile response obtained above.
          await this.timeline(
            result,
            signal,
            undefined,
            cursor,
            req.pageSize,
            (post, sourceUrl) => this.list(post, sourceUrl),
          );
        }
      }
    } else {
      const author = new URL(req.url).pathname.match(
        /^\/([A-Za-z0-9_]+)\/status\//,
      )?.[1];
      let profile: FetchResponse | undefined;
      let discovered: FetchResponse | undefined;
      if (author && author !== "i")
        profile = await this.profile(
          `handle:${author.toLowerCase()}`,
          false,
          signal,
        ).catch((error) => {
          // The handle in a saved link may since have been renamed or
          // suspended; the post itself tells which, so look it up by ID.
          if (
            error instanceof ProviderError &&
            error.code === status.FAILED_PRECONDITION
          )
            return undefined;
          throw error;
        });
      if (!profile) {
        // An ID-only link has no author. Discover it once before selecting the final source.
        try {
          discovered = await this.post(req, signal);
        } catch (error) {
          if (
            !credential ||
            !(error instanceof ProviderError) ||
            error.code !== status.UNAUTHENTICATED
          )
            throw error;
          discovered = await this.session(req.externalId, credential, signal);
        }
        const authorNode = discovered.graph?.entities.find(
          (e) => e.type === "x.profile",
        );
        if (!authorNode)
          throw new ProviderError(
            status.UNAVAILABLE,
            "post author unavailable for capture policy",
          );
        profile = await this.profile(authorNode.externalId, false, signal);
      }
      if (discovered?.providerId === "x-session") {
        result = discovered;
      } else if (this.protected(profile)) {
        if (!credential)
          throw new ProviderError(
            status.PERMISSION_DENIED,
            "帖子受保护，需添加有访问权限的采集账号。",
          );
        result =
          discovered?.providerId === "x-session"
            ? discovered
            : await this.session(req.externalId, credential, signal);
      } else
        result =
          discovered?.providerId === "fxtwitter"
            ? discovered
            : await this.post(req, signal);
      this.attachProfile(result, profile);
    }
    if (req.kind === "profile" && result.nextPageCursor) {
      const previous = req.pageCursor ? JSON.parse(req.pageCursor).cursor : "";
      result.nextPageCursor =
        result.nextPageCursor === previous && !result.incomplete
          ? ""
          : JSON.stringify({
              user: result.canonicalTarget!.externalId,
              mode: this.protected(result) ? "private" : "public",
              cursor: result.nextPageCursor,
            });
    }
    // Execution provider remains the persisted connection choice. textSource and raw URLs record actual sources.
    result.providerId = req.providerId;
    if (credential)
      for (const source of result.sourceResponses)
        source.visibility = Visibility.VISIBILITY_PRIVATE;
    await preferOriginalAvatars(result, signal);
    return result;
  }
  timeline = fetchPublicTimeline;
  // An account sees a deleted post and a post it may not read alike. The public
  // API still tells them apart, so ask it before treating this as lost access.
  private async session(
    id: string,
    credential: SessionCredential,
    signal: AbortSignal,
  ): Promise<FetchResponse> {
    try {
      return await this.sessionPost(id, credential, signal);
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.code !== status.PERMISSION_DENIED
      )
        throw error;
      const gone = await this.publicPost(id, signal).then(
        () => undefined,
        (probe) => (sourceState(probe) ? probe : undefined),
      );
      throw gone ?? error;
    }
  }
  private attachProfile(result: FetchResponse, profile: FetchResponse) {
    const author = result.graph?.entities.find(
      (e) =>
        e.type === "x.profile" &&
        e.externalId === profile.canonicalTarget!.externalId,
    );
    if (author) {
      const node = profile.graph!.entities.find(
        (e) => e.key === profile.graph!.root,
      )!;
      author.dataJson = node.dataJson;
      const data = JSON.parse(Buffer.from(node.dataJson).toString());
      attachMentions(
        result,
        author.key,
        data.metadata?.description,
        data.metadata?.raw_description?.facets,
      );
      author.resourceIndices = profile.resources.map((resource) => {
        let i = result.resources.findIndex(
          (r) => r.url === resource.url && r.purpose === resource.purpose,
        );
        if (i < 0) {
          i = result.resources.length;
          result.resources.push(resource);
        }
        return i;
      });
    }
    result.sourceResponses.push(...profile.sourceResponses);
    const targets = new Map(
      result.relatedTargets.map((target) => [target.url, target]),
    );
    targets.set(profile.canonicalTarget!.url, {
      url: profile.canonicalTarget!.url,
      refreshAfterSeconds: 60,
      updatedAt: "",
    });
    result.relatedTargets = [...targets.values()];
  }
}
