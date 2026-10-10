export const fixtureUser = { pk: "77", username: "fixture.name" };
export function sessionPage(viewer = fixtureUser, profileId = "77") {
  return `<script type="application/json" data-sjs>${JSON.stringify({
    define: [
      ["PolarisViewer", [], { data: viewer }, 0],
      ["DTSGInitialData", [], { token: "fixture-dtsg" }, 0],
      ["LSD", [], { token: "fixture-lsd" }, 0],
    ],
    initialRouteInfo: {
      route: {
        rootView: {
          props: {
            id: profileId,
            page_logging: { params: { profile_id: profileId } },
          },
        },
      },
    },
  })}</script>`;
}
export const mediaPage = (node) =>
  `<script type="application/json" data-sjs>${JSON.stringify({
    data: { xdt_api__v1__media__shortcode__web_info: { items: [node] } },
  })}</script>`;

/** Turns fixed media/profile fixtures into the authenticated web wire format. */
export function sessionFixture(fetcher, verify = () => true) {
  return async (input, init) => {
    const url = new URL(input);
    const cookie = new Headers(init?.headers).get("cookie");
    if (init?.method !== "POST" && !url.pathname.startsWith("/p/"))
      return new Response(sessionPage(), {
        status: verify(cookie) ? 200 : 401,
      });
    const response = await fetcher(input, init);
    if (!response.ok) return response;
    let data;
    try {
      data = await response.clone().json();
    } catch {
      return response;
    }
    if (data.status === "fail" || data.errors || data.error || data.challenge)
      return response;
    const name = new URLSearchParams(init?.body).get(
      "fb_api_req_friendly_name",
    );
    if (url.pathname.startsWith("/p/") && data.items?.[0])
      return new Response(mediaPage(data.items[0]), {
        headers: { "content-type": "text/html" },
      });
    if (name === "PolarisProfilePageContentQuery")
      data = { data: { user: data.user ?? data.data?.user } };
    else if (name?.startsWith("PolarisProfilePosts"))
      data = {
        data: {
          xdt_api__v1__feed__user_timeline_graphql_connection: {
            edges: data.items?.map((node) => ({ node })),
            page_info: {
              has_next_page: !!data.more_available,
              end_cursor: data.next_max_id ?? null,
            },
          },
        },
      };
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  };
}
