import type { InstagramCredentials } from "../../types/proxy-credentials.js";
import { instagramProxyHeaders } from "./account-proxy.js";
import {
  collectDeepByKey,
  extractLsdFromHtml,
  extractPostMediaItem,
  extractPolarisProductFromGraphqlJson,
  findRelayBlobs,
} from "./extractors.js";
import {
  INSTAGRAM_ORIGIN,
  INSTAGRAM_POST_ROOT_DOC_ID,
  INSTAGRAM_POST_ROOT_FRIENDLY_NAME,
} from "./constants.js";
import { instagramShortcodeToPk } from "./shortcode.js";

type Node = Record<string, any>;
export type InstagramSessionTransport = (
  url: string,
  init: RequestInit,
  capture: boolean,
) => Promise<{ text: string; response: Response }>;

export class InstagramSessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

const handle = /^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$/;
const connectionKey = "xdt_api__v1__feed__user_timeline_graphql_connection";
// IDs from the authenticated web client. Keep query variables and fixtures together when updating.
const profileQuery = [
  "PolarisProfilePageContentQuery",
  "28036671149327607",
] as const;
const postsQuery = ["PolarisProfilePostsQuery", "28542612348729311"] as const;
const nextPostsQuery = [
  "PolarisProfilePostsTabContentQuery_connection",
  "28142289515441884",
] as const;
const flags = (names: string[]) =>
  Object.fromEntries(
    names.map((name) => [`__relay_internal__pv__${name}relayprovider`, false]),
  );

interface Bootstrap {
  viewer: Node;
  profileId: string;
  lsd: string;
  dtsg: string;
  referer: string;
}

/** One browser account and transport per request; never rotates accounts or retries anonymously. */
export class InstagramSessionProvider {
  private bootstrapValue?: Bootstrap;
  private profiles = new Map<string, Node>();
  constructor(
    readonly credential: InstagramCredentials,
    private transport: InstagramSessionTransport,
  ) {}

  private async request(path: string, init: RequestInit = {}, capture = true) {
    if (!this.credential.sessionId)
      throw new InstagramSessionError(401, "Instagram requires an account");
    const url = `${INSTAGRAM_ORIGIN}${path}`;
    const headers = new Headers(
      instagramProxyHeaders(
        { ...this.credential, platform: "web" },
        {
          referer: this.bootstrapValue?.referer ?? url,
        },
      ),
    );
    for (const [key, value] of new Headers(init.headers))
      headers.set(key, value);
    const result = await this.transport(url, { ...init, headers }, capture);
    if (!result.response.ok)
      throw new InstagramSessionError(
        result.response.status >= 300 && result.response.status < 400
          ? 401
          : result.response.status,
        "Instagram web request failed",
        result.response.headers.get("retry-after"),
      );
    let data: Node | undefined;
    try {
      data = JSON.parse(result.text.replace(/^for \(;;\);/, ""));
    } catch {}
    if (data && typeof data === "object")
      this.checkErrors(data, result.response);
    return result;
  }

  private async bootstrap(path: string): Promise<Bootstrap> {
    if (this.bootstrapValue) return this.bootstrapValue;
    const { text } = await this.request(path, {}, false);
    let viewer: Node | undefined;
    let dtsg = "";
    let profileId = "";
    for (const root of findRelayBlobs(text)) {
      const definitions: unknown[] = [];
      collectDeepByKey(root, "define", definitions);
      for (const entries of definitions) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!Array.isArray(entry)) continue;
          if (entry[0] === "PolarisViewer") viewer = entry[2]?.data;
          if (entry[0] === "DTSGInitialData") dtsg = entry[2]?.token ?? "";
        }
      }
      const routes: any[] = [];
      collectDeepByKey(root, "initialRouteInfo", routes);
      for (const route of routes) {
        const props = route?.route?.rootView?.props;
        if (props?.id === props?.page_logging?.params?.profile_id)
          profileId = String(props?.id ?? "");
      }
    }
    const id = String(viewer?.pk ?? viewer?.id ?? "");
    if (!viewer || !/^\d+$/.test(id) || !handle.test(viewer.username ?? ""))
      throw new InstagramSessionError(
        401,
        "Instagram session could not be verified",
      );
    if (this.credential.userId && this.credential.userId !== id)
      throw new InstagramSessionError(
        401,
        "Instagram Cookie account does not match its session",
      );
    return (this.bootstrapValue = {
      viewer,
      profileId,
      dtsg,
      lsd: extractLsdFromHtml(text) ?? "",
      referer: `${INSTAGRAM_ORIGIN}${path}`,
    });
  }

  async checkConnection(): Promise<{ accountId: string; username: string }> {
    const { viewer } = await this.bootstrap("/accounts/edit/");
    return {
      accountId: String(viewer.pk ?? viewer.id),
      username: viewer.username,
    };
  }

  private async graphql(
    query: readonly [string, string],
    variables: Node,
    path = "/api/graphql",
  ): Promise<Node> {
    const boot = this.bootstrapValue!;
    if (
      typeof boot.lsd !== "string" ||
      !boot.lsd ||
      typeof boot.dtsg !== "string" ||
      !boot.dtsg
    )
      throw new InstagramSessionError(
        503,
        "Instagram web session tokens are unavailable",
      );
    const [name, doc] = query;
    const body = new URLSearchParams({
      av: String(boot.viewer.pk ?? boot.viewer.id),
      __user: "0",
      __a: "1",
      __comet_req: "7",
      fb_dtsg: boot.dtsg,
      jazoest: `2${[...boot.dtsg].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`,
      lsd: boot.lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: name,
      server_timestamps: "true",
      variables: JSON.stringify(variables),
      doc_id: doc,
    });
    const { text, response } = await this.request(path, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-FB-LSD": boot.lsd,
        "X-FB-Friendly-Name": name,
      },
    });
    let data: Node;
    try {
      data = JSON.parse(text.replace(/^for \(;;\);/, ""));
    } catch {
      throw new InstagramSessionError(
        503,
        "Instagram returned an invalid web response",
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new InstagramSessionError(
        503,
        "Instagram returned an invalid web response",
      );
    this.checkErrors(data, response);
    if (!data.data || typeof data.data !== "object")
      throw new InstagramSessionError(
        503,
        "Instagram returned an invalid web response",
      );
    return data;
  }

  private checkErrors(data: Node, response: Response) {
    // A place's avatar is outside the media/profile result. Instagram can fail this
    // optional field while returning every post and the correct continuation cursor.
    const errors = data.errors?.filter((error: Node) => {
      const path = error.path;
      return !(
        Array.isArray(path) &&
        path.length === 6 &&
        path[0] === connectionKey &&
        path[1] === "edges" &&
        Number.isInteger(path[2]) &&
        path[3] === "node" &&
        path[4] === "location" &&
        path[5] === "profile_pic_url" &&
        /field_exception/.test(String(error.message)) &&
        data.data?.[connectionKey]?.edges?.[path[2]]?.node
      );
    });
    const message = String(
      data.message ?? data.errorSummary ?? errors?.[0]?.message ?? "",
    );
    if (
      data.status === "fail" ||
      data.error ||
      errors?.length ||
      data.challenge ||
      data.checkpoint_url
    ) {
      const code = /login_required|logged.?out/i.test(message)
        ? 401
        : /wait|rate|throttl/i.test(message)
          ? 429
          : /challenge|checkpoint|consent/i.test(message) ||
              data.challenge ||
              data.checkpoint_url
            ? 403
            : 503;
      throw new InstagramSessionError(
        code,
        code === 401
          ? "Instagram session expired; authorize again"
          : code === 429
            ? "Instagram rate limited the request"
            : code === 403
              ? "Instagram requires browser verification"
              : "Instagram web query failed",
        response.headers.get("retry-after"),
      );
    }
  }

  async profile(identity: string): Promise<Node> {
    const numeric = /^\d+$/.test(identity);
    if (!numeric && (!handle.test(identity) || identity.includes("..")))
      throw new InstagramSessionError(
        400,
        "invalid Instagram profile identity",
      );
    const cached = this.profiles.get(identity);
    if (cached) return cached;
    const boot = await this.bootstrap(
      numeric ? "/accounts/edit/" : `/${identity}/`,
    );
    const id = numeric ? identity : boot.profileId;
    if (!/^\d+$/.test(id))
      throw new InstagramSessionError(
        404,
        "Instagram profile not found or inaccessible",
      );
    const data = await this.graphql(profileQuery, {
      id,
      enable_integrity_filters: true,
      ...flags([
        "PolarisCannesGuardianExperienceEnabled",
        "PolarisCASB976ProfileEnabled",
        "PolarisWebSchoolsEnabled",
        "PolarisRepostsConsumptionEnabled",
        "PolarisShortDramaEnabled",
      ]),
    });
    const user = data.data.user;
    if (
      !user ||
      String(user.pk ?? user.id) !== id ||
      !handle.test(user.username ?? "")
    )
      throw new InstagramSessionError(
        503,
        "Instagram returned an invalid profile",
      );
    this.profiles.set(id, user);
    this.profiles.set(user.username, user);
    return user;
  }

  async page(id: string, cursor: string, count: number): Promise<Node> {
    const user = await this.profile(id);
    const variables: Node = {
      username: user.username,
      data: {
        count: Math.min(12, Math.max(1, count)),
        include_reel_media_seen_timestamp: true,
        include_relationship_info: true,
        latest_besties_reel_media: true,
        latest_reel_media: true,
      },
      ...flags([
        "PolarisMultiCaptionCarouselEnabled",
        "PolarisShortDramaEnabled",
        "PolarisReelsRecoDebugOverlayEnabled",
      ]),
    };
    if (cursor)
      Object.assign(variables, {
        after: cursor,
        before: null,
        first: variables.data.count,
        last: null,
        include_multi_captions: false,
      });
    const data = await this.graphql(
      cursor ? nextPostsQuery : postsQuery,
      variables,
      "/graphql/query",
    );
    const connection = data.data[connectionKey];
    if (
      !Array.isArray(connection?.edges) ||
      typeof connection?.page_info?.has_next_page !== "boolean"
    )
      throw new InstagramSessionError(503, "invalid Instagram timeline");
    if (
      connection.page_info.has_next_page &&
      (typeof connection.page_info.end_cursor !== "string" ||
        !connection.page_info.end_cursor ||
        connection.page_info.end_cursor.length > 3000)
    )
      throw new InstagramSessionError(
        503,
        "Instagram timeline cursor is missing",
      );
    const items = connection.edges.map((edge: Node) => edge.node);
    if (items.some((item: unknown) => !item || typeof item !== "object"))
      throw new InstagramSessionError(
        503,
        "invalid Instagram timeline members",
      );
    return {
      items,
      more_available: connection.page_info.has_next_page,
      next_max_id: connection.page_info.has_next_page
        ? connection.page_info.end_cursor
        : "",
    };
  }

  async post(id: string): Promise<Node> {
    if (!/^\d+$/.test(id))
      throw new InstagramSessionError(400, "invalid Instagram post identity");
    let value = BigInt(id),
      code = "";
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    do {
      code = chars[Number(value % 64n)] + code;
      value /= 64n;
    } while (value);
    const path = `/p/${code}/`;
    const { text } = await this.request(path);
    let item = extractPostMediaItem(text);
    if (!item) {
      await this.bootstrap(path);
      const data = await this.graphql(
        [INSTAGRAM_POST_ROOT_FRIENDLY_NAME, INSTAGRAM_POST_ROOT_DOC_ID],
        { media_id: id },
      );
      item = extractPolarisProductFromGraphqlJson(data)?.product ?? null;
    }
    const mediaId = String(item?.pk ?? item?.id ?? "").split("_")[0];
    const shortcode = item?.code ?? item?.shortcode;
    if (
      !item ||
      (/^\d+$/.test(mediaId ?? "")
        ? mediaId !== id
        : typeof shortcode !== "string" ||
          !/^[A-Za-z0-9_-]{1,20}$/.test(shortcode) ||
          String(instagramShortcodeToPk(shortcode)) !== id)
    )
      throw new InstagramSessionError(
        503,
        "Instagram returned a different post",
      );
    return item;
  }
}
