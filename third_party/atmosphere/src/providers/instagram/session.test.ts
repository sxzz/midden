import { describe, expect, it } from "vitest";
import {
  InstagramSessionProvider,
  InstagramSessionError,
  type InstagramSessionTransport,
} from "./session.js";
import {
  fetchPrivateUserById,
  fetchPrivateUserByUsername,
  fetchPrivateUserFeed,
  fetchPrivateMediaInfo,
} from "./private-api.js";
import { resolveInstagramAccounts } from "./account-proxy.js";

const profile = {
  pk: "900",
  username: "new.name",
  is_private: true,
  follower_count: 0,
};
function bootstrap(viewerId = "77", tokens = true, routeId = "900") {
  return `<script data-sjs type="application/json">${JSON.stringify({
    define: [
      [
        "PolarisViewer",
        [],
        { data: { id: viewerId, username: "viewer.name" } },
        0,
      ],
      ...(tokens
        ? [
            ["DTSGInitialData", [], { token: `dtsg-${viewerId}` }, 0],
            ["LSD", [], { token: `lsd-${viewerId}` }, 0],
          ]
        : []),
    ],
    initialRouteInfo: {
      route: {
        rootView: {
          props: {
            id: routeId,
            page_logging: { params: { profile_id: routeId } },
          },
        },
      },
    },
  })}</script>`;
}
const response = (text: string, status = 200) => ({
  text,
  response: new Response(text, { status }),
});
const graph = (data: unknown) => response(JSON.stringify({ data }));
const feed = (ids: string[], more = false, cursor = "") =>
  graph({
    xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: ids.map((pk) => ({ node: { pk, user: profile, media_type: 1 } })),
      page_info: { has_next_page: more, end_cursor: cursor },
    },
  });

describe("request-bound Instagram browser sessions", () => {
  it("routes existing Atmosphere helpers through web profile and Relay pagination", async () => {
    const calls: { path: string; name: string; vars: any; capture: boolean }[] =
      [];
    const transport: InstagramSessionTransport = async (url, init, capture) => {
      expect(new Headers(init.headers).get("cookie")).toBe(
        "sessionid=session; ds_user_id=77",
      );
      expect(url.startsWith("https://www.instagram.com/")).toBe(true);
      if (init.method !== "POST") return response(bootstrap());
      const form = new URLSearchParams(init.body as string);
      const name = form.get("fb_api_req_friendly_name")!;
      const vars = JSON.parse(form.get("variables")!);
      calls.push({ path: new URL(url).pathname, name, vars, capture });
      expect(form.get("fb_dtsg")).toBe("dtsg-77");
      expect(form.get("av")).toBe("77");
      expect(form.get("__user")).toBe("0");
      if (name === "PolarisProfilePageContentQuery")
        return graph({ user: profile });
      if (vars.after) return feed(["3", "4"]);
      return feed(["1", "2"], true, "next-page");
    };
    const session = new InstagramSessionProvider(
      { sessionId: "session", userId: "77" },
      transport,
    );
    const ctx = { session };
    const byHandle = await fetchPrivateUserByUsername("old.name", ctx);
    expect(byHandle.json).toEqual({ user: profile });
    expect((await fetchPrivateUserById("900", ctx)).json).toEqual({
      user: profile,
    });
    const first: any = (await fetchPrivateUserFeed("900", ctx, { count: 100 }))
      .json;
    expect(first.items.map((item: any) => item.pk)).toEqual(["1", "2"]);
    expect(first.next_max_id).toBe("next-page");
    const next: any = (
      await fetchPrivateUserFeed("900", ctx, {
        maxId: first.next_max_id,
        count: 100,
      })
    ).json;
    expect(next.items.map((item: any) => item.pk)).toEqual(["3", "4"]);
    expect(next.more_available).toBe(false);
    expect(calls.map((call) => call.name)).toEqual([
      "PolarisProfilePageContentQuery",
      "PolarisProfilePostsQuery",
      "PolarisProfilePostsTabContentQuery_connection",
    ]);
    expect(calls[2]!.vars).toMatchObject({
      username: "new.name",
      after: "next-page",
      first: 12,
    });
    expect(calls.every((call) => call.capture)).toBe(true);
    expect(await resolveInstagramAccounts(ctx)).toEqual([session.credential]);
  });

  it("refreshes by stable ID after a handle changes", async () => {
    const paths: string[] = [];
    const session = new InstagramSessionProvider(
      { sessionId: "session" },
      async (url, init) => {
        paths.push(new URL(url).pathname);
        if (init.method !== "POST") return response(bootstrap());
        expect(
          JSON.parse(new URLSearchParams(init.body as string).get("variables")!)
            .id,
        ).toBe("900");
        return graph({ user: profile });
      },
    );
    expect((await session.profile("900")).username).toBe("new.name");
    expect(paths).toEqual(["/accounts/edit/", "/api/graphql"]);
  });

  it("keeps cookies and bootstrap tokens separate across simultaneous accounts", async () => {
    const transport: InstagramSessionTransport = async (_url, init) => {
      const cookie = new Headers(init.headers).get("cookie")!;
      const id = cookie.includes("first") ? "77" : "88";
      await new Promise((resolve) => setTimeout(resolve, id === "77" ? 5 : 1));
      if (init.method !== "POST") return response(bootstrap(id));
      const form = new URLSearchParams(init.body as string);
      expect(form.get("fb_dtsg")).toBe(`dtsg-${id}`);
      expect(new Headers(init.headers).get("x-fb-lsd")).toBe(`lsd-${id}`);
      expect(form.get("av")).toBe(id);
      return graph({ user: { ...profile, full_name: id } });
    };
    const accounts = [
      new InstagramSessionProvider(
        { sessionId: "first", userId: "77" },
        transport,
      ),
      new InstagramSessionProvider(
        { sessionId: "second", userId: "88" },
        transport,
      ),
    ];
    const results = await Promise.all(
      accounts.map((account) => account.profile("900")),
    );
    expect(results.map((user) => user.full_name)).toEqual(["77", "88"]);
  });

  it("does not fall back anonymously for invalid sessions, missing tokens or inaccessible targets", async () => {
    for (const [body, expected] of [
      ["<html>Login</html>", 401],
      [bootstrap("88"), 401],
      [bootstrap("77", false), 503],
      [bootstrap("77", true, ""), 404],
    ] as const) {
      let calls = 0;
      const session = new InstagramSessionProvider(
        { sessionId: "session", userId: "77" },
        async () => {
          calls++;
          return response(body);
        },
      );
      await expect(
        fetchPrivateUserByUsername("fixture.name", { session }),
      ).rejects.toMatchObject({ status: expected });
      expect(calls).toBe(1);
    }
  });

  it("recognizes HTTP-200 failures and the JSON protection prefix", async () => {
    for (const [failure, expected] of [
      [{ status: "fail", message: "login_required" }, 401],
      [{ errors: [{ message: "challenge_required" }] }, 403],
      [{ error: 1, errorSummary: "rate limit" }, 429],
      [{ errors: [{ message: "missing_required_variable_value" }] }, 503],
    ] as const) {
      const session = new InstagramSessionProvider(
        { sessionId: "session" },
        async (_url, init) =>
          init.method === "POST"
            ? response(`for (;;);${JSON.stringify(failure)}`)
            : response(bootstrap()),
      );
      await expect(session.profile("900")).rejects.toMatchObject({
        status: expected,
      });
    }
    const good = new InstagramSessionProvider(
      { sessionId: "session" },
      async (_url, init) =>
        init.method === "POST"
          ? response(`for (;;);${JSON.stringify({ data: { user: profile } })}`)
          : response(bootstrap()),
    );
    expect((await good.profile("900")).pk).toBe("900");
  });

  it("rejects a missing continuation cursor instead of claiming that the feed is complete", async () => {
    const session = new InstagramSessionProvider(
      { sessionId: "session" },
      async (_url, init) => {
        if (init.method !== "POST") return response(bootstrap());
        const name = new URLSearchParams(init.body as string).get(
          "fb_api_req_friendly_name",
        );
        return name === "PolarisProfilePageContentQuery"
          ? graph({ user: profile })
          : feed(["1"], true);
      },
    );
    await expect(session.page("900", "", 12)).rejects.toBeInstanceOf(
      InstagramSessionError,
    );
  });

  it("uses the existing HTML extractor for posts and checks their identity", async () => {
    const session = new InstagramSessionProvider(
      { sessionId: "session" },
      async (url, _init, capture) => {
        expect(url).toBe("https://www.instagram.com/p/C/");
        expect(capture).toBe(true);
        return response(
          `<script data-sjs type="application/json">${JSON.stringify({
            xdt_api__v1__media__shortcode__web_info: {
              items: [{ pk: "2", media_type: 8 }],
            },
          })}</script>`,
        );
      },
    );
    expect((await fetchPrivateMediaInfo("2", { session })).json).toEqual({
      items: [{ pk: "2", media_type: 8 }],
    });
  });

  it("keeps complete pages when only an unused location avatar fails", async () => {
    for (const [field, accepted] of [
      ["location", true],
      ["video_versions", false],
    ] as const) {
      const session = new InstagramSessionProvider(
        { sessionId: "session" },
        async (_url, init) => {
          if (init.method !== "POST") return response(bootstrap());
          const name = new URLSearchParams(init.body as string).get(
            "fb_api_req_friendly_name",
          );
          if (name === "PolarisProfilePageContentQuery")
            return graph({ user: profile });
          const data = JSON.parse(feed(["1", "2"], true, "next").text);
          data.errors = [
            {
              message: "A server error field_exception occured.",
              path: [
                "xdt_api__v1__feed__user_timeline_graphql_connection",
                "edges",
                0,
                "node",
                field,
                "profile_pic_url",
              ],
            },
          ];
          return response(JSON.stringify(data));
        },
      );
      if (accepted)
        expect((await session.page("900", "", 12)).items).toHaveLength(2);
      else
        await expect(session.page("900", "", 12)).rejects.toMatchObject({
          status: 503,
        });
    }
  });
});
